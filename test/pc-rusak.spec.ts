import { describe, expect, it } from 'vitest';
import { AccountStatus, AccountType, PcStatus, SessionStatus } from '@prisma/client';
import { SessionService } from '../src/session/session.service.js';

/**
 * Tes untuk flag "PC rusak".
 *
 * ⚠️ Flag `rusak` BUKAN arti "PC ini benar-benar rusak". Itu flag operasional:
 * PC sedang diservis atau sengaja dikosongkan. Yang dijamin hanya dua hal:
 *
 * 1. PC yang ditandai tidak bisa dipakai — sesi baru ditolak.
 * 2. PC yang ditandai tidak muncul di dashboard, halaman login, dan mobile.
 *
 * Yang TIDAK dijamin dan TIDAK boleh berubah: PC yang ditandai tetap masuk
 * laporan, karena rekap dihitung dari `Transaction`/`Session`, bukan daftar PC.
 */

type PcRow = {
  id: string;
  namaPc: string;
  ipClient: string;
  status: PcStatus;
  lastHeartbeatAt: Date | null;
  agentToken: string;
  rusak: boolean;
  alasanRusak: string | null;
};

type AkunRow = {
  id: string;
  kodeUnik: string | null;
  nama: string | null;
  tipe: AccountType;
  status: AccountStatus;
  sisaWaktuDetik: number;
  lastUsedAt: Date | null;
};

const akunRow = (): AkunRow => ({
  id: 'akun-1',
  kodeUnik: 'VCH-1',
  nama: null,
  tipe: AccountType.VOUCHER,
  status: AccountStatus.ACTIVE,
  sisaWaktuDetik: 3600,
  lastUsedAt: null,
});

const pcRow = (): PcRow => ({
  id: 'pc-1',
  namaPc: 'PC001',
  ipClient: '',
  status: PcStatus.IDLE,
  lastHeartbeatAt: new Date(),
  agentToken: 'token-rahasia',
  rusak: false,
  alasanRusak: null,
});

/**
 * Prisma palsu yang hanya-load tabel yang benar-benar disentuh kode: `pc`,
 * `session`, dan `account`. Setiap panggilan dicatat supaya bisa dibuktikan
 * operasi tertentu TIDAK terjadi — bukan cuma mengembalikan nilai yang diharapkan.
 */
function prismaPalsu(pc: PcRow, sesiAda: boolean) {
  const akun = akunRow();
  const dipanggil: string[] = [];

  const prisma = {
    pc: {
      findUnique: async (args: { where: { id: string } }) => {
        dipanggil.push('pc.findUnique');
        return args.where.id === pc.id ? pc : null;
      },
      findMany: async (args?: { where?: { rusak?: boolean } }) => {
        dipanggil.push('pc.findMany');
        if (args?.where?.rusak === false) {
          return pc.rusak ? [] : [pc];
        }
        return [pc];
      },
      update: async () => {
        dipanggil.push('pc.update');
        return { id: pc.id, namaPc: pc.namaPc, rusak: pc.rusak };
      },
    },
    session: {
      findFirst: async () => {
        dipanggil.push('session.findFirst');
        return sesiAda
          ? { id: 'sesi-1', status: SessionStatus.BERJALAN, accountId: akun.id }
          : null;
      },
      findMany: async () => {
        dipanggil.push('session.findMany');
        return sesiAda
          ? [
              {
                id: 'sesi-1',
                pcId: pc.id,
                accountId: akun.id,
                waktuMulai: new Date(),
                status: SessionStatus.BERJALAN,
                account: { tipe: AccountType.VOUCHER, sisaWaktuDetik: 3600 },
              },
            ]
          : [];
      },
      create: async () => {
        dipanggil.push('session.create');
        return { id: 'sesi-baru' };
      },
    },
    account: {
      update: async (args: { data: { lastUsedAt?: Date } }) => {
        dipanggil.push('account.update');
        if (args.data.lastUsedAt) akun.lastUsedAt = args.data.lastUsedAt;
        return akun;
      },
      findMany: async () => [akun],
    },
    setting: { findUnique: async () => null },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma: prisma as any, dipanggil, akun, pc };
}

/** Bypass private: yang diuji efek sampingnya, bukan cara memanggilnya. */
type PemanggilSesi = {
  createSessionAndStart: (
    pcId: string,
    account: unknown,
  ) => Promise<{ success: boolean; message?: string }>;
};
const buatSesi = (svc: SessionService) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc as any as PemanggilSesi;

const akunUntukMulai = () => {
  const a = akunRow();
  return { id: a.id, kodeUnik: a.kodeUnik, nama: a.nama, tipe: a.tipe, sisaWaktuDetik: a.sisaWaktuDetik };
};

describe('penjaga PC rusak di createSessionAndStart', () => {
  // ⚠️ `createSessionAndStart` adalah SATU-SATUNYA pintu untuk tiga cara mulai
  // sesi (`loginRequest`, `startFromDashboard`, `createVoucherAndStart`), jadi
  // tes di sini otomatis menutup ketiga jalurnya sekaligus.
  it('PC ditandai rusak -> sesi ditolak dengan pesan yang jelas', async () => {
    const pc = { ...pcRow(), rusak: true, alasanRusak: 'ganti hard disk' };
    const { prisma, dipanggil } = prismaPalsu(pc, false);
    const svc = new SessionService(prisma);

    const hasil = await buatSesi(svc).createSessionAndStart(pc.id, akunUntukMulai());

    expect(hasil.success).toBe(false);
    expect(hasil.message).toBe('PC sedang tidak dipakai (ditandai rusak)');
    expect(dipanggil).not.toContain('session.create');
  });

  // ⚠️ Ini yang paling mudah salah. Kalau pengecekan `pc.rusak` diletakkan
  // SETELAH penulisan `lastUsedAt`, voucher pelanggan ikut terpakai walau
  // sesinya tidak pernah jalan — dan tidak ada yang sadar karena tidak ada error.
  it('PC rusak tidak boleh menulis lastUsedAt', async () => {
    const pc = { ...pcRow(), rusak: true };
    const { prisma, dipanggil, akun } = prismaPalsu(pc, false);
    const svc = new SessionService(prisma);

    await buatSesi(svc).createSessionAndStart(pc.id, akunUntukMulai());

    expect(dipanggil).not.toContain('account.update');
    expect(akun.lastUsedAt).toBeNull();
  });

  it('PC tidak ada -> ditolak dengan pesan, bukan error foreign key', async () => {
    const { prisma } = prismaPalsu(pcRow(), false);
    const svc = new SessionService(prisma);

    const hasil = await buatSesi(svc).createSessionAndStart('pc-tidak-ada', akunUntukMulai());

    expect(hasil).toEqual({ success: false, message: 'PC tidak ditemukan' });
  });

  it('PC normal -> sesi tetap boleh dibuat', async () => {
    const pc = pcRow();
    const { prisma, dipanggil } = prismaPalsu(pc, false);
    const svc = new SessionService(prisma);

    const hasil = await buatSesi(svc).createSessionAndStart(pc.id, akunUntukMulai());

    expect(hasil.success).toBe(true);
    expect(dipanggil).toContain('session.create');
  });

  it('PC yang sudah punya sesi berjalan tetap ditolak seperti sebelumnya', async () => {
    const pc = pcRow();
    const { prisma } = prismaPalsu(pc, true);
    const svc = new SessionService(prisma);

    const hasil = await buatSesi(svc).createSessionAndStart(pc.id, akunUntukMulai());

    expect(hasil).toEqual({ success: false, message: 'PC sudah memiliki sesi berjalan' });
  });
});

describe('penyaringan daftar PC di dashboard', () => {
  // Dashboard web dan aplikasi mobile sama-sama memakai `dashboard:pc_update`,
  // jadi satu filter di `getDashboardData()` menutup keduanya.
  it('PC yang ditandai rusak tidak ikut terkirim', async () => {
    const pc = { ...pcRow(), rusak: true };
    const { prisma } = prismaPalsu(pc, false);
    const svc = new SessionService(prisma);

    expect(await svc.getDashboardData()).toEqual([]);
  });

  it('PC normal tetap terkirim, dan sesinya ikut', async () => {
    const pc = pcRow();
    const { prisma } = prismaPalsu(pc, true);
    const svc = new SessionService(prisma);

    const hasil = await svc.getDashboardData();

    expect(hasil).toHaveLength(1);
    expect(hasil[0].namaPc).toBe('PC001');
    expect(hasil[0].status).toBe(PcStatus.ACTIVE);
    expect(hasil[0].session).not.toBeNull();
  });

  it('PC rusak yang punya sesi berjalan tetap disembunyikan', async () => {
    // Menandainya sudah menghentikan sesi di `PcService.setRusak()`, tapi kalau ada
    // jalur lain yang menyisakan sesi, daftar tetap harus bersih.
    const pc = { ...pcRow(), rusak: true };
    const { prisma } = prismaPalsu(pc, true);
    const svc = new SessionService(prisma);

    expect(await svc.getDashboardData()).toEqual([]);
  });
});