import { describe, expect, it, vi } from 'vitest';
import { SessionStatus } from '@prisma/client';
import { SessionService } from '../src/session/session.service.js';

/**
 * Tes untuk masa tenggang (grace period) saat socket agent terputus.
 *
 * ⚠️ Kenapa tes ini wajib ada: `grace_period_detik` (bawaan 180 detik) pernah
 * TIDAK berefek apa pun. `handleDisconnect()` langsung memanggil
 * `stopSession(... 'disconnect_timeout')`, dan kolom `disconnectedAt` tidak
 * pernah diisi di mana pun — sehingga `checkGracePeriodExpired()` tidak pernah
 * punya baris untuk diperiksa. Settingnya ada di UI, tapi tidak melakukan apa
 *-apa.
 *
 * Akibatnya di lapangan: kedipan jaringan sedetik apa pun langsung
 * mengeluarkan pelanggan dari PC-nya. Uangnya memang dikembalikan, tapi
 * pelanggan harus login ulang dari awal.
 *
 * Test-case di bawah sengaja ditulis supaya kode LAMA gagal, bukan lulus.
 * Kalau `handleDisconnect()` dipulihkan lagi menjadi pemanggil
 * `stopSession()` langsung, test-case pertama dan kedua gagal.
 */

/**
 * Prisma tiruan.
 *
 * ⚠️ Override dikelompok per model (`{ session, setting, pc, account }`), bukan
 * satu blok datar. Versi pertama menaruh semua override di `session`, jadi
 * `setting.findUnique` tetap `null` — tes "memakai nilai grace_period_detik"
 * lalu diam-diam menguji nilai bawaan 180 dan tidak benar-benar menguji apa pun.
 */
function prismaTiruan(grup: {
  session?: Record<string, unknown>;
  pc?: Record<string, unknown>;
  account?: Record<string, unknown>;
  setting?: Record<string, unknown>;
} = {}) {
  return {
    session: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      ...grup.session,
    },
    pc: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      ...grup.pc,
    },
    account: { update: vi.fn().mockResolvedValue({}), ...grup.account },
    setting: { findUnique: vi.fn().mockResolvedValue(null), ...grup.setting },
  };
}

function buatService(prisma: Record<string, unknown>) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const svc = new SessionService(prisma as never);
  (svc as unknown as { logger: typeof logger }).logger = logger;
  const intervals = (svc as unknown as { sessionIntervals: Map<string, unknown> })
    .sessionIntervals;
  return { svc, logger, intervals };
}

function bersihkan(svc: SessionService, intervals: Map<string, unknown>): void {
  svc.onModuleDestroy();
  intervals.clear();
}

/** Sesi aktif yang belum pernah terputus. */
function sesiAktif(disconnectedAt: Date | null = null) {
  return {
    id: 'sesi-1',
    pcId: 'pc-1',
    status: SessionStatus.BERJALAN,
    disconnectedAt,
    waktuMulai: new Date(Date.now() - 60_000),
    durasiTerpakaiDetik: 60,
    account: { id: 'akun-1', sisaWaktuDetik: 5940, tipe: 'MEMBER', kodeUnik: null, nama: 'musaf' },
    pc: { id: 'pc-1', namaPc: 'PC007' },
  };
}

describe('masa tenggang saat socket terputus', () => {
  it('tidak menghentikan sesi, hanya menandai disconnectedAt', async () => {
    const update = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const { svc, intervals } = buatService(
      prismaTiruan({
        session: { findFirst: vi.fn().mockResolvedValue(sesiAktif()), update, updateMany },
      }),
    );

    await svc.handleDisconnect('pc-1');

    // 🔴 INI inti perbaikannya. Kode lama memanggil stopSession() di sini,
    // yang menulis ke `account` (refund) dan `session` (status SELESAI).
    expect(updateMany).not.toHaveBeenCalled();
    const prisma = (svc as unknown as { prisma: { account: { update: ReturnType<typeof vi.fn> } } })
      .prisma;
    expect(prisma.account.update).not.toHaveBeenCalled();

    // Penanda disconnect harus benar-benar ditulis, kalau tidak masa tenggang
    // tidak akan pernah dihitung.
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0] as { where: { id: string }; data: { disconnectedAt: Date } };
    expect(arg.where.id).toBe('sesi-1');
    expect(arg.data.disconnectedAt).toBeInstanceOf(Date);

    bersihkan(svc, intervals);
  });

  it('TIDAK menulis ulang penanda saat disconnect berikutnya — masa tenggang tidak diperpanjang', async () => {
    const update = vi.fn().mockResolvedValue({});
    // Sesi sudah terputus sebelumnya: disconnectedAt terisi.
    const { svc, intervals } = buatService(
      prismaTiruan({
        session: { findFirst: vi.fn().mockResolvedValue(sesiAktif(new Date())), update },
      }),
    );

    await svc.handleDisconnect('pc-1');

    // Kalau ditulis ulang, tiap disconnect baru akan menggeser ambang dan sesi
    // bisa bertahan selamanya tepat saat seharusnya dihentikan.
    expect(update).not.toHaveBeenCalled();
    bersihkan(svc, intervals);
  });

  it('membersihkan penanda saat agent konek ulang, sebelum masa tenggang habis', async () => {
    const update = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const { svc, intervals } = buatService(
      prismaTiruan({
        session: { findFirst: vi.fn().mockResolvedValue(sesiAktif(new Date())), update, updateMany },
      }),
    );

    await svc.registerPc('pc-1');

    // 🔴 Ini yang menyelamatkan sesi pelanggan. Kalau penanda tidak dihapus,
    // pemeriksa masa tenggang akan menghentikan sesi walau agentnya sudah
    // kembali.
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0] as { where: { id: string }; data: { disconnectedAt: null } };
    expect(arg.where.id).toBe('sesi-1');
    expect(arg.data.disconnectedAt).toBeNull();

    bersihkan(svc, intervals);
  });

  it('tidak menyentuh sesi yang tidak punya penanda disconnect', async () => {
    const update = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const { svc, intervals } = buatService(
      prismaTiruan({
        session: { findFirst: vi.fn().mockResolvedValue(sesiAktif(null)), update, updateMany },
      }),
    );

    await svc.registerPc('pc-1');

    // PC yang konek tanpa sempat terputus: tidak ada yang perlu dibersihkan,
    // jadi tidak boleh ada penulisan ke tabel Session sama sekali.
    expect(update).not.toHaveBeenCalled();
    bersihkan(svc, intervals);
  });

  it('berhenti diam-diam kalau PC tidak punya sesi berjalan', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { svc, intervals } = buatService(
      prismaTiruan({ session: { findFirst: vi.fn().mockResolvedValue(null), update } }),
    );

    await expect(svc.handleDisconnect('pc-1')).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    bersihkan(svc, intervals);
  });

  it('memakai nilai grace_period_detik dari Setting, bukan konstanta', async () => {
    const update = vi.fn().mockResolvedValue({});
    const findUniqueSetting = vi.fn().mockResolvedValue({ value: '45' });
    const { svc, logger, intervals } = buatService(
      prismaTiruan({
        session: { findFirst: vi.fn().mockResolvedValue(sesiAktif()), update },
        setting: { findUnique: findUniqueSetting },
      }),
    );

    await svc.handleDisconnect('pc-1');

    // Setting 45 detik harus ikut dipakai, supaya admin bisa mengaturnya.
    expect(findUniqueSetting).toHaveBeenCalled();
    const pesan = logger.log.mock.calls.map((c) => String(c[0])).join(' ');
    expect(pesan).toContain('45');
    bersihkan(svc, intervals);
  });

  it('pemeriksa masa tenggang tetap menghentikan sesi yang sudah lewat ambang', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const accountUpdate = vi.fn().mockResolvedValue({});
    const { svc, intervals } = buatService(
      prismaTiruan({
        session: {
          findUnique: vi.fn().mockResolvedValue(sesiAktif(new Date(Date.now() - 999_000))),
          updateMany,
        },
        account: { update: accountUpdate },
      }),
    );

    await svc.stopSession('sesi-1', 'disconnect_timeout');

    // Sisa waktu pelanggan harus dikembalikan, bukan hangus.
    expect(accountUpdate).toHaveBeenCalled();
    bersihkan(svc, intervals);
  });
});