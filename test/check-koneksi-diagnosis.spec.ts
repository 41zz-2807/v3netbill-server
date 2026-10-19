import { describe, expect, it, vi } from 'vitest';
import { SessionService } from '../src/session/session.service.js';

/**
 * Tes `checkKoneksiDiagnosis()` — bagian yang BENAR-BENAR menulis ke log.
 *
 * 🔴 Ini yang diminta operator: "kalau heartbeat dan ping berhenti berdekatan
 * maka normal, dan semuanya tertulis di log untuk investigasi".
 *
 * Dua risiko yang harus dijaga:
 *
 * 1. **Log penuh.** Checker jalan tiap 10 detik. Kalau menulis tiap
 *    sambaan, delapan PC sehat saja sudah menghasilkan ribuan baris sehari
 *    dan jejaknya tidak bisa dibaca.
 * 2. **PC yang sengaja dimatikan terbaca sebagai insiden.** Kasir sering
 *    mematikan PC, dan itu tidak boleh muncul sebagai sesuatu yang perlu
 *    diperiksa.
 *
 * Fungsi murni `diagnosisKoneksi()` diuji terpisah di `koneksi-diagnosis.spec.ts`.
 * Yang diuji di sini adalah bentuk pemanggilannya, karena jebakan yang sama
 * sudah beberapa kali menggigit modul ini: logika murni benar, tapi pemanggilannya
 *-nya salah bentuk sehingga hasilnya tidak pernah terpakai.
 */

type ServiceDiagnosis = SessionService & {
  checkKoneksiDiagnosis(): Promise<void>;
  tulisRingkasanDiagnosis(): void;
  diagnosisTerakhir: Map<string, string>;
};

const NAMA_PC = 'PC002';

/** Sinyal dibuat relatif terhadap `sekarang`, supaya tidak ada jam sia-sia. */
function heartbeatUmurDetik(detik: number): Date {
  return new Date(Date.now() - detik * 1000);
}

type Usia = { hb: number; pong: number | null };

function buatService(umurHeartbeatDetik: number, umurPongDetik: number | null) {
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];
  // Usia sinyal dibuat mutable supaya satu tes bisa menyegarkan keduanya
  // tanpa membangun ulang service.
  const usia: Usia = { hb: umurHeartbeatDetik, pong: umurPongDetik };

  const prisma = {
    // ⚠️ `setting` wajib ada walau tes ini tidak pernah menyentuhnya.
    // Constructor memanggil `loadGracePeriod()` tanpa menunggu, jadi fake
    // yang tidak punya `setting` menghasilkan unhandled rejection yang
    // dilaporkan sebagai "Unhandled Errors" -- bukan kegagalan tes.
    setting: { findUnique: vi.fn(async () => null) },
    pc: {
      findMany: vi.fn(async () => [
        {
          id: 'pc-1',
          namaPc: NAMA_PC,
          lastHeartbeatAt: new Date(Date.now() - usia.hb * 1000),
        },
      ]),
    },
  };

  const gatewayEvents = {
    waktuPongTerakhir: vi.fn(() =>
      usia.pong === null ? null : new Date(Date.now() - usia.pong * 1000),
    ),
    broadcastActivityLog: vi.fn((event: string, payload: Record<string, unknown>) => {
      log.push({ event, payload });
    }),
    logTickError: vi.fn(),
  };

  const svc = new SessionService(prisma as never) as unknown as ServiceDiagnosis;
  (svc as unknown as { gatewayEvents: unknown }).gatewayEvents = gatewayEvents;

  return { svc, log, gatewayEvents, usia };
}

/**
 * Prisma tiruan yang SENGAJA gagal saat `pc.findMany` -- itu yang diuji.
 *
 * ⚠️ Tapi `setting.findUnique` tetap disediakan. Constructor memanggil
 * `loadGracePeriod()`, dan kalau fake-nya `{}` penolakan itu tidak punya
 * catcher sehingga jadi unhandled rejection: bukan kegagalan tes yang
 * wanted, tapi bisa menjatuhkan proses test runner. Dua-duanya tetap
 * terlihat "hijau" kalau keluarannya hanya difilter `grep`.
 */
function prismaGagal(): never {
  return { setting: { findUnique: async () => null } } as never;
}

describe('checkKoneksiDiagnosis', () => {
  it('tidak menulis apa pun saat PC sehat dari awal', async () => {
    // PC yang baru dinyalakan selalu mulai dari keadaan sehat. Kalau itu
    // langsung dicatat, setiap PC akan punya satu baris sia-sia tiap nyala.
    const { svc, log } = buatService(2, 1);
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(0);
  });

  it('tidak menulis berulang saat diagnosis tetap sama', async () => {
    // 🔴 Checker jalan tiap 10 detik. Tanpa penjaga ini, log berisi baris
    // yang sama terus-menerus dan tidak bisa dibaca.
    const { svc, log } = buatService(60, 4); // agent hang, stabil
    await svc.checkKoneksiDiagnosis();
    await svc.checkKoneksiDiagnosis();
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe('koneksi:diagnosis');
  });

  it('agen hang ditulis sekali dan menyebut keadaannya', async () => {
    const { svc, log } = buatService(60, 4);
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(1);
    expect(log[0].payload['alasan']).toBe('SUSPICIOUS_AGENT_HANG');
    expect(log[0].payload['pc']).toBe(NAMA_PC);
    // 🔴 Kuncinya `keterangan`, bukan `detail`. `log-billing.service.ts`
    // menulis berkas dari `payload['keterangan']`, jadi memakai `detail`
    // membuat kolom penjelas kosong di berkas log -- tanpa error sama sekali,
    // karena allow-listnya diam-diam melewatkan kunci yang tidak dikenal.
    expect(String(log[0].payload['keterangan'])).toContain('PERLU DICIKAT');
    expect(log[0].payload['detail']).toBeUndefined();
  });

  it('PC yang sengaja mati tidak memicu catatan pertama', async () => {
    // ⚠️ Ini yang paling mudah salah. PC dimatikan kasir selalu punya heartbeat
    // basi DAN pong basi, jadi diagnosisnya PUTUS_BERSAMA dari detik pertama.
    // Kalau itu ditulis, setiap PC yang dimatikan akan terbaca sebagai
    // insiden -- dan setiap restart backend jadi delapan baris sia-sia.
    const { svc, log } = buatService(600, 600);
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(0);
  });

  it('perpindahan dari hidup ke putus DICATAT, bukan dilewati diam-diam', async () => {
    // 🔴 Ini yang sebelumnya hilang. Versi lama hanya menulis agent-hang dan
    // pemulihan ke HIDUP, jadi disconnect yang paling ingin dicari operator --
    // yaitu HIDUP -> PUTUS_BERSAMA -- justru tidak pernah masuk log.
    const { svc, log, usia } = buatService(1, 1);
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(0); // HIDUP dari awal tidak diumumkan

    usia.hb = 600;
    usia.pong = 600;
    await svc.checkKoneksiDiagnosis();

    expect(log).toHaveLength(1);
    expect(log[0].payload['alasan']).toBe('PUTUS_BERSAMA');
    expect(log[0].payload['pc']).toBe(NAMA_PC);
  });

  it('perpindahan ke state tidak berdekatan ikut dicatat', async () => {
    // Selisih 400 detik jauh dari ambang 10 detik, jadi ini tidak boleh
    // dilabeli "restart bersih".
    const { svc, log, usia } = buatService(1, 1);
    await svc.checkKoneksiDiagnosis();

    usia.hb = 600;
    usia.pong = 200;
    await svc.checkKoneksiDiagnosis();

    expect(log).toHaveLength(1);
    expect(log[0].payload['alasan']).toBe('PUTUS_TIDAK_BERDEKATAN');
    expect(String(log[0].payload['keterangan'])).toContain('PERLU DICIKAT');
  });

  it('status yang tidak berubah tidak diulang', async () => {
    const { svc, log, usia } = buatService(1, 1);
    await svc.checkKoneksiDiagnosis();
    usia.hb = 600;
    usia.pong = 600;
    await svc.checkKoneksiDiagnosis();
    await svc.checkKoneksiDiagnosis();
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(1);
  });

  it('pulih dari agent hang dicatat sekali', async () => {
    const { svc, log, usia } = buatService(60, 4);
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(1);
    expect(log[0].payload['alasan']).toBe('SUSPICIOUS_AGENT_HANG');

    // ⚠️ KEDUA sinyal harus segar. Kalau hanya pong yang disegarkan,
    // heartbeat masih basi dan diagnosisnya tetap agent hang — jadi tidak
    // ada yang berubah dan tidak ada yang dicatat. Itu memang perilaku yang
    // benar, dan tesnya harus memastikan bedanya.
    usia.hb = 1;
    usia.pong = 1;
    await svc.checkKoneksiDiagnosis();

    expect(log).toHaveLength(2);
    expect(log[1].payload['alasan']).toBe('HIDUP');
  });

  it('hanya pong yang segar TIDAK mengubah diagnosis agent hang', async () => {
    // Dua-duanya harus basi supaya agent hang terus berlanjut. Kalau hanya
    // satu yang dipulihkan dan itu yang dianggap pulih, log akan menulis
    // "sudah normal" padahal agentnya masih tidak mengirim.
    const { svc, log, usia } = buatService(60, 4);
    await svc.checkKoneksiDiagnosis();

    usia.pong = 1;
    await svc.checkKoneksiDiagnosis();

    expect(log).toHaveLength(1);
  });

  it('kegagalan tidak melempar keluar', async () => {
    // Pemanggilnya `setInterval`. Penolakan apa pun yang lolos dari sana
    // menjadi unhandled rejection dan mematikan SELURUH proses Node.
    const svc = new SessionService(prismaGagal()) as unknown as ServiceDiagnosis;
    (svc as unknown as { gatewayEvents: unknown }).gatewayEvents = {
      waktuPongTerakhir: () => null,
      broadcastActivityLog: vi.fn(),
      logTickError: vi.fn(),
    };
    await expect(svc.checkKoneksiDiagnosis()).resolves.toBeUndefined();
  });

  it('tidak menulis kalau gateway belum siap', async () => {
    // `gatewayEvents` null sebelum `setGatewayEvents()`. Kalau tidak
    // dijaga, checker akan melempar pada startup.
    const svc = new SessionService(prismaGagal()) as unknown as ServiceDiagnosis;
    await expect(svc.checkKoneksiDiagnosis()).resolves.toBeUndefined();
  });

  it('tidak menulis apa pun saat PC sehat dari awal', async () => {
    // PC yang baru dinyalakan selalu mulai dari keadaan sehat. Kalau itu
    // langsung dicatat, setiap PC akan punya satu baris sia-sia tiap nyala.
    const { svc, log } = buatService(2, 1);
    await svc.checkKoneksiDiagnosis();
    expect(log).toHaveLength(0);
  });
});

describe('tulisRingkasanDiagnosis', () => {
  it('periode tanpa perubahan tidak menghasilkan apa pun', async () => {
    // ⚠️ Menulis ringkasan nol setiap 15 menit berarti 96 baris sia-sia
    // sehari yang isinya "tidak ada yang terjadi".
    const { svc, log } = buatService(2, 1);
    await svc.checkKoneksiDiagnosis();
    svc.tulisRingkasanDiagnosis();
    expect(log).toHaveLength(0);
  });

  it('ringkasan menghitung perubahan status, bukan jumlah pengecekan', async () => {
    // 🔴 Checker jalan tiap 10 detik. Kalau yang dihitung adalah jumlah cek,
    // angkanya cuma dibagi 144 dan tidak informasi apa pun. Yang dihitung
    // harus jumlah PERUBAHAN status.
    const { svc, log, usia } = buatService(2, 1);
    await svc.checkKoneksiDiagnosis();
    await svc.checkKoneksiDiagnosis();
    await svc.checkKoneksiDiagnosis();
    usia.hb = 600;
    usia.pong = 600;
    await svc.checkKoneksiDiagnosis();
    await svc.checkKoneksiDiagnosis();

    svc.tulisRingkasanDiagnosis();

    const ringkasan = log.find((b) => b.payload['alasan'] === 'RINGKASAN');
    expect(ringkasan).toBeDefined();
    expect(String(ringkasan!.payload['keterangan'])).toContain('PUTUS_BERSAMA 1x');
  });

  it('ringkasan dihitung ulang setelah ditulis', async () => {
    // Kalau tidak dikosongkan, periode berikutnya mengulang angka yang sama
    // dan jumlah sebenarnya jadi tidak pernah terlihat.
    const { svc, log, usia } = buatService(60, 4);
    await svc.checkKoneksiDiagnosis();

    svc.tulisRingkasanDiagnosis();
    svc.tulisRingkasanDiagnosis();

    const ringkasan = log.filter((b) => b.payload['alasan'] === 'RINGKASAN');
    expect(ringkasan).toHaveLength(1);

    usia.hb = 2;
    usia.pong = 1;
    await svc.checkKoneksiDiagnosis();
    svc.tulisRingkasanDiagnosis();

    const semua = log.filter((b) => b.payload['alasan'] === 'RINGKASAN');
    expect(semua).toHaveLength(2);
    expect(String(semua[1].payload['keterangan'])).toContain('HIDUP 1x');
  });

  it('ringkasan menyebut jumlah yang perlu tindakan', async () => {
    const { svc, log } = buatService(60, 4);
    await svc.checkKoneksiDiagnosis();
    svc.tulisRingkasanDiagnosis();

    const ringkasan = log.find((b) => b.payload['alasan'] === 'RINGKASAN');
    expect(String(ringkasan!.payload['keterangan'])).toContain('Perlu tindakan 1');
  });

  it('kegagalan ringkasan tidak melempar keluar', async () => {
    // ⚠️ Dipanggil dari setInterval. Penolakan yang lolos jadi unhandled
    // rejection yang menjatuhkan SELURUH proses Node.
    const svc = new SessionService(prismaGagal()) as unknown as ServiceDiagnosis;
    (svc as unknown as { gatewayEvents: unknown }).gatewayEvents = {
      broadcastActivityLog: () => {
        throw new Error('boom');
      },
      logTickError: vi.fn(),
    };
    // ⚠️ Penghitung harus diisi lebih dulu. Kalau tidak, method keluar lebih
    // awal karena tidak ada yang bisa diringkas -- jadi `catch` yang diuji
    // justru tidak pernah dieksekusi dan tesnya lulus tanpa bukti apa pun.
    (svc as unknown as { jumlahDiagnosis: Map<string, number> }).jumlahDiagnosis.set(
      'PUTUS_BERSAMA',
      2,
    );
    expect(() => svc.tulisRingkasanDiagnosis()).not.toThrow();
  });
});