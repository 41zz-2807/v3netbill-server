import { describe, expect, it, vi } from 'vitest';
import { SessionStatus } from '@prisma/client';
import { SessionService } from '../src/session/session.service.js';

/**
 * Tes untuk `recoverRunningSessions()` — jalur yang membuat sesi pelanggan
 * selamat dari restart server.
 *
 * ⚠️ Kenapa tes ini perlu ada: sebelumnya **nol** tes menyentuh recovery.
 * `auto-shutdown.spec.ts` memanggil `setGatewayEvents()`, jadi recovery
 * kebetulan ikut jalan terhadap mock yang mengembalikan `[]` — tapi tidak ada
 * satu pun assertion tentang hasilnya. Kalau `recoverRunningSessions()` dihapus
 * seluruhnya, semua tes lama tetap hijau.
 *
 * Yang diuji di sini justru sisi MEMATIKAN: recovery dipanggil dari
 * `afterInit()` yang tidak `await`, jadi penolakan di dalamnya menjadi
 * unhandled rejection, dan Node 20 menjatuhkan SELURUH proses kalau itu
 * terjadi saat startup. Satu query Prisma yang gagal tidak boleh berarti tidak
 * ada satu pun PC yang bisa billing.
 */

/**
 * Prisma tiruan.
 *
 * ⚠️ `pc` wajib ada walau tes ini tidak memanggilnya: constructor
 * `SessionService` menjalankan `startDisconnectCheck()`, yang memanggil
 * `pc.findMany` / `pc.updateMany`. Tanpa itu, interval berjalan di atas mock
 * yang salah dan errornya muncul di tempat yang tidak ada hubungannya.
 *
 * ⚠️ `setting` juga wajib, untuk alasan yang sama: constructor menjalankan
 * `loadGracePeriod()` fire-and-forget, dan tanpa `setting.findUnique` ia
 * melempar unhandled rejection yang membuat vitest menandai file ini gagal.
 */
function prismaTiruan(session: Record<string, unknown>) {
  return {
    session: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      ...session,
    },
    pc: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    account: { update: vi.fn().mockResolvedValue({}) },
    setting: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

function buatService(prisma: Record<string, unknown>) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const svc = new SessionService(prisma as never);
  // `logger` private di TS, tapi di JS tetap field biasa.
  (svc as unknown as { logger: typeof logger }).logger = logger;
  const intervals = (svc as unknown as { sessionIntervals: Map<string, unknown> }).sessionIntervals;
  return { svc, logger, intervals };
}

/** Matikan semua interval — tanpa ini vitest menggantung karena timer masih hidup. */
function bersihkan(svc: SessionService, intervals: Map<string, unknown>): void {
  expect(intervals.size).toBeGreaterThanOrEqual(0);
  svc.onModuleDestroy();
  intervals.clear();
}

describe('recoverRunningSessions', () => {
  it('menyalakan tick untuk setiap sesi yang masih BERJALAN', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const { svc, intervals } = buatService(prismaTiruan({ findMany }));

    await svc.setGatewayEvents({} as never);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(intervals.size).toBe(3);
    bersihkan(svc, intervals);
  });

  it('hanya mengambil sesi BERJALAN, dan hanya kolom id', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const { svc, intervals } = buatService(prismaTiruan({ findMany }));

    await svc.setGatewayEvents({} as never);

    const arg = findMany.mock.calls[0][0] as { where: { status: string }; select: unknown };
    expect(arg.where.status).toBe(SessionStatus.BERJALAN);
    // `select` dipakai supaya tidak menarik relasi yang tidak dibutuhkan.
    expect(arg.select).toEqual({ id: true });
    bersihkan(svc, intervals);
  });

  it('TIDAK melempar saat database menolak — ini yang membuat server bisa start', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('connection refused'));
    const { svc, logger, intervals } = buatService(prismaTiruan({ findMany }));

    // Kalau ini melempar, `afterInit()` mendapat unhandled rejection dan
    // seluruh proses Node mati saat startup.
    await expect(svc.setGatewayEvents({} as never)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Recovery sesi gagal membaca database'),
    );
    bersihkan(svc, intervals);
  });

  it('satu sesi yang gagal tidak menghalangi sesi lain ikut di-recovery', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: 'baik1' }, { id: 'jahat' }, { id: 'baik2' }]);
    const { svc, intervals } = buatService(prismaTiruan({ findMany }));

    // Paksa `startSessionTick` gagal tepat untuk satu id.
    const target = svc as unknown as { startSessionTick: (id: string) => void };
    const asli = target.startSessionTick.bind(svc);
    target.startSessionTick = (id: string) => {
      if (id === 'jahat') throw new Error('interval gagal');
      asli(id);
    };

    await expect(svc.setGatewayEvents({} as never)).resolves.toBeUndefined();
    expect(intervals.size).toBe(2);
    bersihkan(svc, intervals);
  });

  it('tidak men-log apa pun saat tidak ada sesi berjalan', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const { svc, logger, intervals } = buatService(prismaTiruan({ findMany }));

    await svc.setGatewayEvents({} as never);

    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('Recovery:'));
    bersihkan(svc, intervals);
  });

  it('memberitahu jumlah gagal, bukan hanya jumlah hidup', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const { svc, logger, intervals } = buatService(prismaTiruan({ findMany }));

    const target = svc as unknown as { startSessionTick: (id: string) => void };
    const asli = target.startSessionTick.bind(svc);
    target.startSessionTick = (id: string) => {
      if (id === 'b') throw new Error('gagal');
      asli(id);
    };

    await svc.setGatewayEvents({} as never);

    // Tanpa angka gagal, operator melihat "3 sesi dipulihkan" padahal satu
    // di antaranya tidak — dan tidak ada yang mengetahuinya.
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('2 sesi berjalan'));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('1 gagal'));
    bersihkan(svc, intervals);
  });
});
