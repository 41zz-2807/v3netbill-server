import { describe, expect, it, vi } from 'vitest';
import { AccountStatus, AccountType, SessionStatus } from '@prisma/client';
import { SessionService } from '../src/session/session.service.js';

/**
 * Tes untuk isi payload `session:stopped`.
 *
 * ⚠️ Ini yang hilang sebelumnya dan tidak ketahuan dari membaca kode: halaman
 * Log Aktivitas menulis kolom Detail dari payload ini, dan `session:stopped`
 * **tidak pernah mengirim akunnya**. Akibatnya setiap sesi berakhir tampil
 * sebagai "Waktu habis, sisa kembali 0j 00:00" — kalimat yang sama persis
 * untuk sesi siapa pun. Kasir tidak pernah bisa tahu akun mana yang barusan
 * selesai, padahal itu justru informasi yang dicari.
 *
 * `session:started` sudah mengirim `akun` sejak awal; sekarang `stopped` juga.
 */

type Akun = {
  id: string;
  kodeUnik: string | null;
  nama: string;
  sisaWaktuDetik: number;
  status: AccountStatus;
  tipe: AccountType;
};

function harness(akun: Partial<Akun> = {}) {
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const akunPenuh: Akun = {
    id: 'akun-1',
    kodeUnik: null,
    nama: 'Budi Santoso',
    sisaWaktuDetik: 3600,
    status: AccountStatus.ACTIVE,
    tipe: AccountType.MEMBER,
    ...akun,
  };

  const prisma = {
    session: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'sesi-1',
        pcId: 'pc-1',
        accountId: akunPenuh.id,
        waktuMulai: new Date(Date.now() - 600 * 1000),
        status: SessionStatus.BERJALAN,
        account: akunPenuh,
        pc: { namaPc: 'PC001' },
      }),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    account: { update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    pc: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    setting: { findUnique: vi.fn().mockResolvedValue(null) },
  };

  const svc = new SessionService(prisma as never);
  (svc as unknown as { logger: typeof logger }).logger = logger;

  svc.setGatewayEvents({
    emitSessionStop: vi.fn(),
    broadcastPcUpdate: vi.fn(async () => {}),
    broadcastActivityLog: (event: string, payload: Record<string, unknown>) => {
      log.push({ event, payload });
    },
    logTickError: vi.fn(),
    matikanPcOtomatis: vi.fn(async () => true),
  } as never);

  return { svc, log, prisma };
}

describe('payload session:stopped', () => {
  it('MEMBAWA akun — tanpa ini kolom Detail tidak pernah menyebut siapa', async () => {
    const { svc, log } = harness({ kodeUnik: null, nama: 'Budi Santoso' });

    await svc.stopSession('sesi-1', 'habis');

    const stopped = log.find((l) => l.event === 'session:stopped');
    expect(stopped).toBeDefined();
    expect(stopped!.payload.akun).toBe('Budi Santoso');
  });

  it('utamakan kodeUnik untuk voucher, karena itu yang tampil di dashboard', async () => {
    const { svc, log } = harness({
      kodeUnik: '500344',
      nama: 'Voucher 500344',
      tipe: AccountType.VOUCHER,
    });

    await svc.stopSession('sesi-1', 'manual');

    const stopped = log.find((l) => l.event === 'session:stopped');
    // Sama seperti `session:started`: kodeUnik didahulukan, nama adalah cadangan.
    expect(stopped!.payload.akun).toBe('500344');
  });

  it('konsisten dengan session:started — pasangan log bisa dibaca utuh', async () => {
    const { svc, log } = harness({ kodeUnik: null, nama: 'Siti' });

    await svc.stopSession('sesi-1', 'manual');

    const stopped = log.find((l) => l.event === 'session:stopped')!;
    // Field yang sudah ada sebelumnya tidak boleh hilang gara-gara tambahan baru.
    expect(stopped.payload.alasan).toBe('manual');
    expect(stopped.payload.sessionId).toBe('sesi-1');
    expect(stopped.payload.pcId).toBe('pc-1');
    expect(stopped.payload.sisaWaktuKembali).toBeGreaterThanOrEqual(0);
  });

  it('akun null tetap terkirim sebagai nilai, bukan field hilang', async () => {
    // Nama dan kodeUnik kosong adalah data yang mungkin terjadi. Kalau field-nya
    // jadi `undefined`, `JSON.stringify` BUANG field itu dari `detail` —
    // sehingga log lama dan log baru punya bentuk berbeda.
    const { svc, log } = harness({ kodeUnik: null, nama: '' });

    await svc.stopSession('sesi-1', 'manual');

    const stopped = log.find((l) => l.event === 'session:stopped')!;
    // `??` membuat nama kosong jatuh ke string kosong, yang tetap ter-serialize.
    expect(stopped.payload.akun).toBe('');
  });

  it('stopSession menolak sesi yang sudah tidak ada, tanpa error', async () => {
    const { svc, log } = harness();
    // Sesi bisa hilang antara tick dan panggilan stop (mis. di-`bersihkan-data`).
    // `findUnique` mengembalikan null -> stopSession harus keluar SENJAJA.
    (svc as unknown as { prisma: { session: { findUnique: unknown } } }).prisma.session.findUnique =
      vi.fn().mockResolvedValue(null);

    await expect(svc.stopSession('sesi-hilang', 'manual')).resolves.toBeUndefined();
    expect(log.length).toBe(0);
  });
});
