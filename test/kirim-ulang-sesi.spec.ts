import { describe, expect, it, vi } from 'vitest';
import { AccountStatus, AccountType, SessionStatus } from '@prisma/client';
import { SessionService, sisaWaktuSekarang } from '../src/session/session.service.js';

/**
 * Tes untuk pengiriman ulang `session:start` ke agent yang (re)connect.
 *
 * ⚠️ Ini menutup celah yang HANYA bisa ditutup dari server. `_currentState` di
 * `Worker.cs` diinisialisasi `Locked` dan TIDAK ADA permintaan state ke server
 * dari sisi agent, jadi service yang restart membuat layar PC kembali ke form
 * login sementara server masih menagih. Mengirim ulang `session:start` menutup
 * celah itu tanpa perlu install MSI baru — karena handler yang menerimanya
 * (`Worker.OnSessionStarted` dan `Overlay.ApplySessionStarted`) sudah idempoten
 * di versi agent yang terpasang (1.0.17.0).
 *
 * Fungsi ini jalan di SETIAP konek, jadi dua hal wajib diuji:
 *   1. Sesi yang ada -> dikirim dengan SISA WAKTU SEKARANG, bukan durasi awal.
 *   2. Error -> tidak boleh melempar, karena pemanggilnya `registerAgent()`
 *      yang sudah memutuskan socket lama milik PC lain.
 */

describe('sisaWaktuSekarang', () => {
  const mulai = new Date('2026-10-06T00:00:00.000Z');

  it('sebelum sesi berjalan -> saldo penuh', () => {
    expect(sisaWaktuSekarang(mulai, 3600, mulai.getTime())).toBe(3600);
  });

  it('setelah 600 detik terpakai -> sisa dikurangi tepat', () => {
    expect(sisaWaktuSekarang(mulai, 3600, mulai.getTime() + 600_000)).toBe(3000);
  });

  it('sudah lewat -> 0, bukan angka negatif', () => {
    expect(sisaWaktuSekarang(mulai, 600, mulai.getTime() + 3_600_000)).toBe(0);
  });

  it('waktuMulai di masa depan -> tidak menghasilkan sisa negatif', () => {
    // `lastUsedAt`/`waktuMulai` yang skewed karena jam PC kasir salah bisa
    // membuat `waktuMulai` sedikit di masa depan. Hasilnya harus tetap aman.
    expect(sisaWaktuSekarang(mulai, 3600, mulai.getTime() - 5_000)).toBe(3600);
  });

  it('pembulatan selalu ke bawah, tidak pernah ke atas', () => {
    // 0,9 detik terpakai harus membulatkan ke 0 — kalau ke atas, saldo
    // pelanggan bertambah 1 detik setiap reconnect.
    expect(sisaWaktuSekarang(mulai, 3600, mulai.getTime() + 999)).toBe(3600);
    expect(sisaWaktuSekarang(mulai, 3600, mulai.getTime() + 1_000)).toBe(3599);
  });
});

function harness(sesi: unknown) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const findFirst = vi.fn().mockResolvedValue(sesi);
  const svc = new SessionService({
    session: { findFirst, findUnique: vi.fn().mockResolvedValue(null) },
    pc: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
    account: { findMany: vi.fn().mockResolvedValue([]) },
  } as never);
  (svc as unknown as { logger: typeof logger }).logger = logger;
  return { svc, findFirst, logger };
}

const sesiContoh = {
  id: 'sesi-1',
  pcId: 'pc-1',
  accountId: 'akun-1',
  waktuMulai: new Date(Date.now() - 900_000),
  status: SessionStatus.BERJALAN,
  account: {
    id: 'akun-1',
    kodeUnik: '500344',
    nama: 'Voucher 500344',
    sisaWaktuDetik: 3600,
    status: AccountStatus.ACTIVE,
    tipe: AccountType.VOUCHER,
  },
};

describe('sesiBerjalanUntukAgent', () => {
  it('tidak ada sesi -> null (agent tidak boleh dikirimi session:start)', async () => {
    const { svc, findFirst } = harness(null);

    expect(await svc.sesiBerjalanUntukAgent('pc-1')).toBeNull();
    // ⚠️ WAJIB memfilter status. Tanpa itu, sesi yang sudah SELESAI akan
    // ikut terkirim dan layar PC masuk ke mode sesi padahal tidak ada tagihan.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pcId: 'pc-1', status: SessionStatus.BERJALAN } }),
    );
  });

  it('sesi berjalan -> kirim sessionId, sisa SEKARANG, dan identitas akun', async () => {
    const { svc } = harness(sesiContoh);

    const hasil = await svc.sesiBerjalanUntukAgent('pc-1');

    expect(hasil).not.toBeNull();
    expect(hasil!.sessionId).toBe('sesi-1');
    // 3600 saldo - 900 terpakai = 2700.
    expect(hasil!.sisaDetik).toBeGreaterThanOrEqual(2698);
    expect(hasil!.sisaDetik).toBeLessThanOrEqual(2700);
    expect(hasil!.akun).toEqual({ kodeUnik: '500344', nama: 'Voucher 500344', tipe: 'VOUCHER' });
  });

  it('member member tanpa kodeUnik -> nama tetap terkirim', async () => {
    // Member tidak punya kodeUnik sama sekali (17 dari 17 di server), jadi
    // kalau `nama` ikut hilang, overlay menampilkan "?" sebagai identitas akun.
    const { svc } = harness({
      ...sesiContoh,
      account: { ...sesiContoh.account, kodeUnik: null, nama: 'Budi Santoso', tipe: 'MEMBER' },
    });

    const hasil = await svc.sesiBerjalanUntukAgent('pc-1');

    expect(hasil!.akun).toEqual({ kodeUnik: null, nama: 'Budi Santoso', tipe: 'MEMBER' });
  });

  it('sisa waktu tidak pernah melebihi saldo akun', async () => {
    const { svc } = harness({
      ...sesiContoh,
      account: { ...sesiContoh.account, sisaWaktuDetik: 0 },
    });

    const hasil = await svc.sesiBerjalanUntukAgent('pc-1');

    expect(hasil!.sisaDetik).toBe(0);
  });
});