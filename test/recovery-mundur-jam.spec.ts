import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../src/session/session.service.js';

/**
 * Tes untuk pemunduran jam sesi saat server start ulang.
 *
 * ⚠️ Ini sisi produksi yang hilang selama ini, dan gejalanya justru terlihat benar:
 *
 * ```
 * 20:00  listrik mati total — server ikut mati, proses dibunuh OS
 * 21:02  server hidup lagi, recoverRunningSessions() menyalakan tick
 *        -> Session masih BERJALAN, hitung mundur JALAN lagi
 *        -> tapi `now - waktuMulai` sudah include 1 jam gelap
 *        -> saldo pelanggan terpotong 1 jam tanpa ada yang memakai
 * ```
 *
 * Bukti nyata di produksi: sesi PC004 akun `3333` tercatat
 * `durasiTerpakaiDetik = 12000` (3j20m) untuk periode 19:01-22:21, dan
 * `sisaKembali = 7312` — sekitar 1 jam dari 3j20m itu adalah waktu mati
 * listrik. Uangnya hilang.
 *
 * ⚠️ **Yang DIPERBAIKI di sini bukan "deteksi mati listrik", tapi "memundurkan
 * jam".** Mati listrik tidak bisa dibedakan dari crash server, kabel putus,
 * atau Postgres mati — dan sistem tidak boleh menebak. Yang diketahui dengan
 * kepastian absolut cuma satu: `durasiTerpakaiDetik`, yaitu detik yang benar
 * -benar terpakai, ditulis tick tiap detik ke database dan selamat dari listrik
 * yang dicabut.
 *
 * Sisa waktu TIDAK bisa dihentikan dengan mematikan tick, karena
 * `sisaWaktuSekarang()` = `saldo - (now - waktuMulai)` dihitung saat BACA.
 * Tick cuma menulis. Jadi satu-satunya cara memandikan jam adalah memindahkan
 * `waktuMulai` ke depan — persis yang diuji di sini.
 */

/** Dipatok supaya assertion bisa eksak, bukan "kira-kira". */
const NOW = new Date('2026-10-16T04:00:00.000Z');

interface Sesi {
  id: string;
  durasiTerpakaiDetik: number;
  waktuMulai: Date;
}

function prismaTiruan(sesi: Sesi[], updateMock?: ReturnType<typeof vi.fn>) {
  const update = updateMock ?? vi.fn().mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue(sesi);
  return {
    update,
    findMany,
    prisma: {
      session: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        update,
        findMany,
      },
      pc: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      account: { update: vi.fn().mockResolvedValue({}) },
      setting: { findUnique: vi.fn().mockResolvedValue(null) },
    },
  };
}

function buatService(tiruan: { prisma: Record<string, unknown>; update: ReturnType<typeof vi.fn> }) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const svc = new SessionService(tiruan.prisma as never);
  (svc as unknown as { logger: typeof logger }).logger = logger;
  const intervals = (svc as unknown as { sessionIntervals: Map<string, unknown> })
    .sessionIntervals;
  return { svc, logger, intervals, update: tiruan.update };
}

function dataUpdate(update: ReturnType<typeof vi.fn>, index = 0) {
  return (update.mock.calls[index][0] as { data: Record<string, Date> }).data;
}

describe('recoverRunningSessions — pemunduran jam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('memundurkan waktuMulai ke pemakaian terakhir yang tercatat', async () => {
    // 19:01 WIB start, sudah terpakai 2 jam, server hidup lagi 3 jam kemudian.
    const tiruan = prismaTiruan([
      { id: 's1', durasiTerpakaiDetik: 7200, waktuMulai: new Date(NOW.getTime() - 10800_000) },
    ]);
    const { svc, update, intervals } = buatService(tiruan);

    await svc.setGatewayEvents({} as never);

    // 3 jam gelap TIDAK ikut terpotong: jam mundur ke NOW - 2 jam.
    expect(dataUpdate(update).waktuMulai).toEqual(new Date(NOW.getTime() - 7200_000));
    svc.onModuleDestroy();
    intervals.clear();
  });

  it('mengisi disconnectedAt supaya masa tenggang benar-benar aktif', async () => {
    // Tanpa ini, `sesiDalamMasaTenggang()` selalu false dan
    // `checkGracePeriodExpired()` tidak punya baris untuk diperiksa — sesi di PC
    // mati listrik akan tetap jalan sampai kehabisan waktu.
    const tiruan = prismaTiruan([
      { id: 's1', durasiTerpakaiDetik: 60, waktuMulai: new Date(NOW.getTime() - 61_000) },
    ]);
    const { svc, update, intervals } = buatService(tiruan);

    await svc.setGatewayEvents({} as never);

    expect(dataUpdate(update).disconnectedAt).toEqual(NOW);
    svc.onModuleDestroy();
    intervals.clear();
  });

  it('sesi yang baru mulai (0 detik terpakai) tidak dirusak', async () => {
    // `Math.max(0, ...)` wajib: nilai negatif akan memundurkan jam ke masa depan.
    const tiruan = prismaTiruan([
      { id: 's1', durasiTerpakaiDetik: -50, waktuMulai: new Date(NOW.getTime() - 1000) },
    ]);
    const { svc, update, intervals } = buatService(tiruan);

    await svc.setGatewayEvents({} as never);

    expect(dataUpdate(update).waktuMulai).toEqual(NOW);
    svc.onModuleDestroy();
    intervals.clear();
  });

  it('TETAP menyalakan tick walau pemunduran gagal — sesi tidak boleh beku', async () => {
    // Ini penjaga terpenting. Kalau update ditolak dan tick ikut dilewati,
    // sesi itu tidak ditagih dan tidak juga berhenti: berhenti bekerja untuk
    // warnet, dan tidak ada yang mengetahuinya.
    const update = vi.fn().mockRejectedValue(new Error('P2025'));
    const tiruan = prismaTiruan(
      [{ id: 's1', durasiTerpakaiDetik: 10, waktuMulai: new Date(NOW.getTime() - 20_000) }],
      update,
    );
    const { svc, logger, intervals } = buatService(tiruan);

    await expect(svc.setGatewayEvents({} as never)).resolves.toBeUndefined();

    expect(intervals.size).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('memundurkan'),
    );
    svc.onModuleDestroy();
    intervals.clear();
  });

  it('memudurkan tiap sesi secara terpisah', async () => {
    const tiruan = prismaTiruan([
      { id: 's1', durasiTerpakaiDetik: 100, waktuMulai: new Date(NOW.getTime() - 200_000) },
      { id: 's2', durasiTerpakaiDetik: 900, waktuMulai: new Date(NOW.getTime() - 1000_000) },
    ]);
    const { svc, update, intervals } = buatService(tiruan);

    await svc.setGatewayEvents({} as never);

    expect(update).toHaveBeenCalledTimes(2);
    expect(dataUpdate(update, 0).waktuMulai).toEqual(new Date(NOW.getTime() - 100_000));
    expect(dataUpdate(update, 1).waktuMulai).toEqual(new Date(NOW.getTime() - 900_000));
    svc.onModuleDestroy();
    intervals.clear();
  });
});