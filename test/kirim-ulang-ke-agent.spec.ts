import { describe, expect, it, vi } from 'vitest';
import { SessionGateway } from '../src/session/session.gateway.js';

/**
 * Tes untuk `kirimUlangSesiKeAgent()`.
 *
 * ⚠️ Fungsi ini dipanggil di DALAM `registerAgent()`, tepat setelah socket
 * lama PC itu diputus. Kalau ia melempar, agent PC tersebut **tidak akan
 * terdaftar sama sekali** — dan `registerAgent()` sudah memutus socket lama
 * milik PC lain sebelum pemanggilan ini. Jadi satu query yang gagal berarti
 * PC itu berhenti Online sampai reconnect berikutnya.
 *
 * Yang diuji adalah sisi MEMATIKAN, bukan sisi berhasil: itu sudah terbukti
 * live dengan agent simulasi (menerima `session:start` dengan sisa 1495 dtk
 * dari saldo 1800 yang sudah terpakai 305 dtk).
 */

/** Punya akses ke private lewat cast — sama seperti yang dilakukan service lain. */
type Gateway = SessionGateway & {
  kirimUlangSesiKeAgent(pcId: string): Promise<void>;
  pcSocketMap: Map<string, string>;
  emitSessionStart: ReturnType<typeof vi.fn>;
};

function buatGateway(sesiBerjalan: () => unknown) {
  const emitSessionStart = vi.fn();
  const sessionService = {
    sesiBerjalanUntukAgent: vi.fn(async () => sesiBerjalan()),
    registerPc: vi.fn(async () => {}),
  };
  const gw = new SessionGateway(
    sessionService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const g = gw as unknown as Gateway;
  g.emitSessionStart = emitSessionStart;
  g.pcSocketMap = new Map();
  return { g, emitSessionStart, sessionService };
}

describe('kirimUlangSesiKeAgent', () => {
  it('tidak ada sesi -> tidak mengirim apa pun', async () => {
    const { g, emitSessionStart } = buatGateway(() => null);

    await g.kirimUlangSesiKeAgent('pc-1');

    expect(emitSessionStart).not.toHaveBeenCalled();
  });

  it('ada sesi -> kirim sessionId, sisa SEKARANG, dan akun', async () => {
    const { g, emitSessionStart } = buatGateway(() => ({
      sessionId: 'sesi-1',
      sisaDetik: 1495,
      akun: { kodeUnik: null, nama: 'Budi', tipe: 'MEMBER' },
    }));

    await g.kirimUlangSesiKeAgent('pc-1');

    expect(emitSessionStart).toHaveBeenCalledWith('pc-1', 'sesi-1', 1495, {
      kodeUnik: null,
      nama: 'Budi',
      tipe: 'MEMBER',
    });
  });

  // ⚠️ Ini yang paling penting. Satu query Prisma yang gagal tidak boleh
  // membuat agent gagal terdaftar.
  it('query GAGAL -> tidak melempar, agent tetap bisa jalan', async () => {
    const { g, emitSessionStart } = buatGateway(() => {
      throw new Error('database tidak terjangkau');
    });

    await expect(g.kirimUlangSesiKeAgent('pc-1')).resolves.toBeUndefined();
    expect(emitSessionStart).not.toHaveBeenCalled();
  });

  it('emitSessionStart gagal -> tetap tidak melempar', async () => {
    const { g } = buatGateway(() => ({
      sessionId: 'sesi-1',
      sisaDetik: 100,
      akun: { kodeUnik: '1', nama: 'X', tipe: 'VOUCHER' },
    }));
    g.emitSessionStart = vi.fn(() => {
      throw new Error('socket hilang di tengah jalan');
    });

    await expect(g.kirimUlangSesiKeAgent('pc-1')).resolves.toBeUndefined();
  });

  it('dipanggil dengan pcId yang benar', async () => {
    const { g, sessionService } = buatGateway(() => null);

    await g.kirimUlangSesiKeAgent('pc-abc');

    expect(sessionService.sesiBerjalanUntukAgent).toHaveBeenCalledWith('pc-abc');
  });
});