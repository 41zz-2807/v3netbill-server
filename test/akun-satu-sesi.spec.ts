import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { SessionService, pesanAkunTerpakai } from '../src/session/session.service.js';

/**
 * Satu akun = satu sesi berjalan.
 *
 * ⚠️ Dulu semua jalur mulai sesi hanya menanyakan "PC ini dipakai orang lain?",
 * tidak pernah "akun ini sedang dipakai di PC lain?". Akibatnya member yang
 * sama berjalan di PC002 dan PC003 bersamaan, hitung mundur keduanya saling
 * melompat, dan satu sesi yang habis mematikan sesi lainnya. Terjadi 3 kali
 * di produksi (5, 6, 7 Okt).
 *
 * ⚠️ `loginRequest` dulu membuat sesinya SENDIRI (salinan blok yang sama),
 * jadi penjaga di `createSessionAndStart` saja tidak cukup. Dua tes di sini
 * memastikan setiap jalur benar-benar lewat penjaga.
 */

const HASH = bcrypt.hashSync('0000', 4);

const akun = {
  id: 'akun-sela',
  tipe: 'MEMBER',
  kodeUnik: null,
  nama: 'sela',
  passwordHash: HASH,
  sisaWaktuDetik: 13199,
  status: 'ACTIVE',
  lastUsedAt: null,
};

interface Opsi {
  sesiAkun?: { pc: { namaPc: string } } | null;
  sesiPc?: { id: string } | null;
  pcRusak?: boolean;
  createError?: unknown;
}

function buat(o: Opsi = {}) {
  const prisma = {
    setting: { findUnique: vi.fn().mockResolvedValue(null) },
    account: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(akun),
      update: vi.fn().mockResolvedValue({}),
    },
    pc: {
      findUnique: vi.fn().mockResolvedValue({ rusak: o.pcRusak ?? false }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
    session: {
      findFirst: vi.fn(async (args: { where: { pcId?: string; accountId?: string } }) => {
        if (args.where.accountId) return o.sesiAkun ?? null;
        if (args.where.pcId) return o.sesiPc ?? null;
        return null;
      }),
      create: vi.fn(async () => {
        if (o.createError) throw o.createError;
        return { id: 'sesi-baru' };
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const svc = new SessionService(prisma as never);
  (svc as unknown as { startSessionTick: () => void }).startSessionTick = vi.fn();
  return { svc, prisma };
}

const tutup = (svc: SessionService) => svc.onModuleDestroy();

describe('satu akun satu sesi berjalan', () => {
  it('dashboard start: akun yang sudah berjalan di PC lain ditolak', async () => {
    const { svc, prisma } = buat({ sesiAkun: { pc: { namaPc: 'PC002' } } });
    const r = await svc.startFromDashboard('pc-3', 'sela');
    expect(r.success).toBe(false);
    expect(r.message).toBe('Akun sedang dipakai di PC002');
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    tutup(svc);
  });

  it('login dari layar PC: akun yang sudah berjalan di PC lain ditolak', async () => {
    const { svc, prisma } = buat({ sesiAkun: { pc: { namaPc: 'PC002' } } });
    const r = await svc.loginRequest('pc-3', { nama: 'sela', password: '0000' });
    expect(r.success).toBe(false);
    expect(r.message).toBe('Akun sedang dipakai di PC002');
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    tutup(svc);
  });

  it('login dari layar PC: PC yang ditandai rusak ditolak (jalur ini dulu tidak punya penjaga)', async () => {
    const { svc, prisma } = buat({ pcRusak: true });
    const r = await svc.loginRequest('pc-3', { nama: 'sela', password: '0000' });
    expect(r.success).toBe(false);
    expect(r.message).toContain('rusak');
    expect(prisma.session.create).not.toHaveBeenCalled();
    tutup(svc);
  });

  it('akun bebas: sesi dibuat tepat satu kali, lewat kedua jalur', async () => {
    for (const mulai of [
      (s: SessionService) => s.loginRequest('pc-3', { nama: 'sela', password: '0000' }),
      (s: SessionService) => s.startFromDashboard('pc-3', 'sela'),
    ]) {
      const { svc, prisma } = buat();
      const r = await mulai(svc);
      expect(r.success).toBe(true);
      expect(r.sessionId).toBe('sesi-baru');
      expect(prisma.session.create).toHaveBeenCalledTimes(1);
      tutup(svc);
    }
  });

  it('PC yang sedang dipakai tetap ditolak dengan pesan PC (bukan pesan akun)', async () => {
    const { svc } = buat({ sesiPc: { id: 'x' } });
    const r = await svc.startFromDashboard('pc-3', 'sela');
    expect(r.message).toBe('PC sudah memiliki sesi berjalan');
    tutup(svc);
  });

  it('balapan: indeks unik menolak sesi kedua (P2002) tanpa melempar dan tanpa menandai lastUsedAt', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
    const { svc, prisma } = buat({ createError: err });
    const r = await svc.startFromDashboard('pc-3', 'sela');
    expect(r.success).toBe(false);
    expect(r.message).toBe(pesanAkunTerpakai(null));
    expect(prisma.account.update).not.toHaveBeenCalled();
    tutup(svc);
  });

  it('error database lain tidak ditelan', async () => {
    const { svc } = buat({ createError: new Error('koneksi putus') });
    await expect(svc.startFromDashboard('pc-3', 'sela')).rejects.toThrow('koneksi putus');
    tutup(svc);
  });
});
