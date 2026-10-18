import { describe, expect, it, vi } from 'vitest';
import { SessionGateway } from '../src/session/session.gateway.js';

/**
 * Tes untuk "PC harus dikunci kembali setelah masa tenggang habis".
 *
 * 🔴 BUG YANG DIUJI INI (kejadian nyata 17 Okt 2026, PC002, 15:10-15:30 WIB):
 *
 * ```
 * 15:20:03  agent PC002 putus socket -> disconnectedAt diisi
 * 15:22:04  masa tenggang 120 detik habis -> stopSession('disconnect_timeout')
 *           -> emitSessionStop() memanggil server.to(socketId), TAPI socket
 *              sudah tidak ada, jadi perintahnya DIBAUANG
 *           -> server sudah IDLE, uang sudah dikembalikan
 *           -> overlay masih menampilkan hitung mundur basi
 * 15:24:09  kasir baru tekan "Matikan" — tanpa itu PC tetap terbuka
 * ```
 *
 * Dua sebab, dan keduanya harus ditutup:
 *
 * 1. `emitSessionStop()` membuang perintah saat socket hilang — dan masa tenggang
 *    habis itu PASTI berarti socket hilang, jadi perintah ini selalu dibuang
 *    tepat di kasus yang paling penting. Tidak ada antrean, tidak ada retry,
 *    tidak ada log.
 *
 * 2. `kirimUlangSesiKeAgent()` me-return kosong kalau tidak ada sesi. Jadi saat
 *    agent reconnect, server tidak pernah mengirim "tidak ada sesi, kembali ke
 *    layar login" — overlay terus menampilkan state lamanya.
 *
 * Di sisi agent, `Worker.cs` hanya bisa kembali ke `Locked` lewat
 * `ForceLockScreenAsync()`, yang dipicu `session:stop` saja. `_currentState`
 *-nya in-memory, jadi kalau `session:stop` tidak pernah sampai, PC terkunci
 * bertahan selamanya dengan hitung mundur yang terus turun dari nilai basi.
 *
 * Dampak ekonomi: bukan uang pelanggan yang hilang (sisa waktu dikembalikan
 * dengan benar), tapi pelanggan bisa memakai PC GRATIS selama hitung mundur basi
 * itu habis — pada insiden 17 Okt nilainya sekitar 87 menit.
 */

type Gateway = SessionGateway & {
  kirimUlangSesiKeAgent(pcId: string): Promise<void>;
  emitSessionStop(
    pcId: string,
    alasan: 'manual' | 'habis' | 'disconnect_timeout',
    akun?: { kodeUnik: string | null; nama: string | null; tipe: 'VOUCHER' | 'MEMBER' },
    sisaKembaliDetik?: number,
  ): void;
  pcSocketMap: Map<string, string>;
  menungguDikunci: Set<string>;
  emitSessionStart: ReturnType<typeof vi.fn>;
};

const AKUN = { kodeUnik: null, nama: 'monik', tipe: 'MEMBER' as const };

function buatGateway() {
  const emit = vi.fn();
  const server = { to: vi.fn(() => ({ emit })) };

  const prisma = {
    pc: { findUnique: vi.fn(async () => ({ namaPc: 'PC002' })) },
  };
  const notifikasiService = { kirimSesiTerputus: vi.fn(async () => {}) };
  const sessionService = {
    sesiBerjalanUntukAgent: vi.fn(async () => null),
    registerPc: vi.fn(async () => {}),
  };

  const gw = new SessionGateway(
    sessionService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifikasiService as never,
    prisma as never,
  );
  const g = gw as unknown as Gateway;
  g.emitSessionStart = vi.fn();
  g.pcSocketMap = new Map();
  g.server = server as never;
  return { g, emit, server, notifikasiService, sessionService };
}

describe('PC harus dikunci kembali setelah masa tenggang habis', () => {
  it('emitSessionStop tanpa socket -> menandai PC supaya dikunci saat reconnect', () => {
    const { g, emit } = buatGateway();

    // Socket TIDAK ada: inilah kondisi saat grace period benar-benar habis.
    g.emitSessionStop('pc-1', 'disconnect_timeout', AKUN, 5122);

    expect(emit).not.toHaveBeenCalled();
    expect(g.menungguDikunci.has('pc-1')).toBe(true);
  });

  it('BUG INI: reconnect tanpa sesi + ada penanda -> agent:lock terkirim', async () => {
    const { g, emit } = buatGateway();
    // ⚠️ Urutannya penting dan meniru keadaan nyata: sesi Berakhir saat
    // agent SUDAH offline (masa tenggang habis selalu begitu), baru
    // kemudian socket muncul lagi saat agent konek ulang.
    g.emitSessionStop('pc-1', 'disconnect_timeout', AKUN, 5122);
    expect(g.menungguDikunci.has('pc-1')).toBe(true);
    emit.mockClear();

    g.pcSocketMap.set('pc-1', 'socket-1');
    await g.kirimUlangSesiKeAgent('pc-1');

    expect(emit).toHaveBeenCalledWith('admin:lock', { pcId: 'pc-1' });
    expect(g.emitSessionStart).not.toHaveBeenCalled();
  });

  it('penanda sudah dikirim -> dibersihkan, tidak dikirim ulang selamanya', async () => {
    const { g, emit } = buatGateway();
    g.emitSessionStop('pc-1', 'disconnect_timeout', AKUN, 0);
    g.pcSocketMap.set('pc-1', 'socket-1');

    await g.kirimUlangSesiKeAgent('pc-1');
    expect(emit).toHaveBeenCalledWith('admin:lock', { pcId: 'pc-1' });
    emit.mockClear();

    // Reconnect kedua tidak boleh mengunci lagi tanpa sebab.
    await g.kirimUlangSesiKeAgent('pc-1');

    expect(emit).not.toHaveBeenCalled();
    expect(g.menungguDikunci.has('pc-1')).toBe(false);
  });

  it('reconnect tanpa sesi dan TANPA penanda -> tetap diam (perilaku lama dipertahankan)', async () => {
    const { g, emit } = buatGateway();
    g.pcSocketMap.set('pc-1', 'socket-1');

    await g.kirimUlangSesiKeAgent('pc-1');

    expect(emit).not.toHaveBeenCalled();
    expect(g.emitSessionStart).not.toHaveBeenCalled();
  });

  it('emitSessionStop DENGAN socket -> terkirim langsung, tidak ada penanda tertinggal', () => {
    const { g, emit } = buatGateway();
    g.pcSocketMap.set('pc-1', 'socket-1');

    g.emitSessionStop('pc-1', 'manual', AKUN, 100);

    expect(emit).toHaveBeenCalledWith('session:stop', { alasan: 'manual' });
    expect(g.menungguDikunci.has('pc-1')).toBe(false);
  });

  it('penanda tetap dibuat walau alasan lain / akun tidak ada', () => {
    const { g } = buatGateway();

    // Tanpa akun pun LOCK tetap wajib: yang perlu dikunci adalah layarnya,
    // bukan notifikasi. Account undefined cuma mematikan FCM.
    g.emitSessionStop('pc-1', 'disconnect_timeout', undefined, 0);
    expect(g.menungguDikunci.has('pc-1')).toBe(true);

    g.menungguDikunci.clear();
    g.emitSessionStop('pc-2', 'habis', undefined, 0);
    expect(g.menungguDikunci.has('pc-2')).toBe(true);
  });

  it('sesi masih hidup -> kirim session:start, JANGAN kunci layar', async () => {
    const { g, emit, sessionService } = buatGateway();
    // Penanda tertinggal dari peristiwa lama, lalu ada sesi SAH yang baru
    // berjalan di PC ini.
    g.emitSessionStop('pc-1', 'disconnect_timeout', AKUN, 0);
    g.pcSocketMap.set('pc-1', 'socket-1');
    emit.mockClear();

    sessionService.sesiBerjalanUntukAgent.mockResolvedValue({
      sessionId: 'sesi-1',
      sisaDetik: 1495,
      akun: AKUN,
    });

    await g.kirimUlangSesiKeAgent('pc-1');

    // MelLOCK di sini akan mengeluarkan pelanggan yang sedang sah bermain.
    expect(g.emitSessionStart).toHaveBeenCalledWith('pc-1', 'sesi-1', 1495, AKUN);
    expect(emit).not.toHaveBeenCalled();
    expect(g.menungguDikunci.has('pc-1')).toBe(false);
  });

  it('kirimUlangSesiKeAgent tidak melempar walau emit lock gagal', async () => {
    const { g, server } = buatGateway();
    g.emitSessionStop('pc-1', 'disconnect_timeout', AKUN, 0);
    g.pcSocketMap.set('pc-1', 'socket-1');

    server.to.mockImplementation(() => {
      throw new Error('socket hilang di tengah jalan');
    });

    await expect(g.kirimUlangSesiKeAgent('pc-1')).resolves.toBeUndefined();
  });
});