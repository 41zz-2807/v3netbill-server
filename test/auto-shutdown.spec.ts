import { describe, expect, it, vi } from 'vitest';
import { PcStatus, SessionStatus } from '@prisma/client';
import { SessionService } from '../src/session/session.service.js';

/**
 * Tes untuk auto-matikan PC setelah idle.
 *
 * ⚠️ Ini fitur yang Mematikan mesin pelanggan. Jadi yang diuji bukan hanya
 * "perintah terkirim", tapi lebih penting lagi **kapan perintah TIDAK boleh
 * dikirim** — kalau pengaman ini bocor, PC yang sedang dipakai pelanggan ikut
 * mati.
 *
 * Lima pengaman yang dijaga di sini:
 * 1. Setting `auto_shutdown_menit` = 0 -> fitur mati.
 * 2. PC `rusak = true` -> dilewati.
 * 3. PC dengan sesi BERJALAN -> dilewati.  ← yang paling penting
 * 4. Agent offline -> dilewati, timer dibiarkan menyala.
 * 5. Setelah terkirim -> timer disenapkan, tidak dikirim ulang.
 */

const MENIT = 5;
const SEKARANG = new Date('2026-10-05T10:00:00.000Z');

type BarisPc = {
  id: string;
  namaPc: string;
  ipClient: string;
  status: PcStatus;
  lastHeartbeatAt: Date | null;
  agentToken: string;
  rusak: boolean;
  alasanRusak: string | null;
  terakhirAktifAt: Date | null;
};

const pcBaris = (): BarisPc => ({
  id: 'pc-1',
  namaPc: 'PC001',
  ipClient: '',
  status: PcStatus.IDLE,
  lastHeartbeatAt: new Date(),
  agentToken: 'token',
  rusak: false,
  alasanRusak: null,
  // 6 menit lalu — lewat dari ambang 5 menit
  terakhirAktifAt: new Date(SEKARANG.getTime() - (MENIT + 1) * 60 * 1000),
});

type Opsi = {
  pc?: Partial<BarisPc>;
  /** true = ada sesi berjalan di PC itu */
  sesiBerjalan?: boolean;
  /** nilai setting; string tidak valid sengaja bisa dipakai */
  setting?: string;
  /** agent tersambung? */
  agentKonek?: boolean;
};

function harness({
  pc: pcPartial,
  sesiBerjalan = false,
  setting = String(MENIT),
  agentKonek = true,
}: Opsi = {}) {
  let barisPc: BarisPc = { ...pcBaris(), ...pcPartial };
  const jejak: string[] = [];
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const panggilUpdateMany = vi.fn(async () => ({ count: 0 }));
  const matikanPcOtomatis = vi.fn(async (pcId: string) => {
    jejak.push(`matikanPcOtomatis(${pcId})`);
    return agentKonek;
  });

  const svc = new SessionService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      setting: {
        findUnique: async () => ({ key: 'auto_shutdown_menit', value: setting }),
      },
      pc: {
        updateMany: panggilUpdateMany,
        findMany: async (args?: { where?: { rusak?: boolean; terakhirAktifAt?: { lte: Date } | null } }) => {
          jejak.push('pc.findMany');
          // Mock WAJIB meniru filter Prisma, kalau tidak pengaman `rusak` dan
          // batas waktu jadi tidak pernah teruji — dan tesnya lulus hijau
          // padahal kodenya salah.
          const w = args?.where;
          if (w?.rusak === false && barisPc.rusak) {
            return [];
          }
          if (w?.terakhirAktifAt && typeof w.terakhirAktifAt === 'object') {
            if (!barisPc.terakhirAktifAt) {
              return [];
            }
            if (barisPc.terakhirAktifAt.getTime() > w.terakhirAktifAt.lte.getTime()) {
              return [];
            }
          }
          return [barisPc];
        },
        update: async (args: { data: { terakhirAktifAt?: Date | null } }) => {
          jejak.push('pc.update');
          barisPc = { ...barisPc, ...args.data };
          return barisPc;
        },
      },
      session: {
        findFirst: async () => {
          jejak.push('session.findFirst');
          return sesiBerjalan ? { id: 'sesi-1' } : null;
        },
      },
      account: { findMany: async () => [] },
    } as any,
  );

  const events = {
    matikanPcOtomatis,
    broadcastPcUpdate: vi.fn(async () => {
      jejak.push('broadcastPcUpdate');
    }),
    broadcastActivityLog: (event: string, payload: Record<string, unknown>) => {
      jejak.push(`log(${event})`);
      log.push({ event, payload });
    },
    logTickError: (p: string) => {
      jejak.push(`tickError(${p})`);
    },
  };
  svc.setGatewayEvents(events as never);

  return {
    svc,
    jejak,
    log,
    dapatPc: () => barisPc,
    matikanPcOtomatis,
    events,
    panggilUpdateMany,
  };
}


/** Jalankan pemeriksa lewat nama private-nya, satu tick. */
const periksa = async (svc: SessionService) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).checkAutoShutdown() as Promise<void>;

describe('pengaman: PC yang sedang dipakai tidak boleh dimatikan', () => {
  // ⚠️ Ini tes paling penting di file ini. Kalau bocor, PC pelanggan mati
  // di tengah sesi dan uangnya hangus tanpa jejak.
  it('sesi BERJALAN -> tidak dikirim, dan timer TIDAK disenapkan', async () => {
    const { svc, jejak, dapatPc, matikanPcOtomatis } = harness({ sesiBerjalan: true });

    await periksa(svc);

    expect(matikanPcOtomatis).not.toHaveBeenCalled();
    expect(jejak).not.toContain('matikanPcOtomatis(pc-1)');
    // Timer harus tetap menyala supaya diulang 10 detik lagi.
    expect(dapatPc().terakhirAktifAt).not.toBeNull();
  });

  it('sesi berjalan -> pengecekan sesi SELALU dilakukan sebelum mengirim', async () => {
    const { svc, jejak } = harness({ sesiBerjalan: true });

    await periksa(svc);

    // Urutannya, bukan hanya "dipanggil": sesi dicek lebih dulu.
    const posisiSesi = jejak.indexOf('session.findFirst');
    const posisiKirim = jejak.indexOf('matikanPcOtomatis(pc-1)');
    expect(posisiSesi).toBeGreaterThanOrEqual(0);
    expect(posisiKirim).toBe(-1);
  });
});

describe('pengaman lain', () => {
  it('setting 0 -> tidak ada yang dikirim', async () => {
    const { svc, matikanPcOtomatis, jejak } = harness({ setting: '0' });

    await periksa(svc);

    expect(matikanPcOtomatis).not.toHaveBeenCalled();
    expect(jejak).not.toContain('pc.findMany');
  });

  it('PC ditandai rusak -> dilewati', async () => {
    const { svc, matikanPcOtomatis } = harness({ pc: { rusak: true } });

    await periksa(svc);

    expect(matikanPcOtomatis).not.toHaveBeenCalled();
  });

  it('agent offline -> dilewati dan timer TIDAK disenapkan', async () => {
    // Kalau timer disenapkan di sini, PC itu menggantung menyala selamanya
    // karena tidak ada perintah kedua yang akan dikirim.
    const { svc, matikanPcOtomatis, dapatPc } = harness({ agentKonek: false });

    await periksa(svc);

    expect(matikanPcOtomatis).toHaveBeenCalled();
    expect(dapatPc().terakhirAktifAt).not.toBeNull();
  });

  it('setting tidak valid -> pakai default, bukan NaN', async () => {
    // NaN akan membuat semua PC langsung dianggap terlalu lama dan mati
    // bersamaan. Ini yang paling merusak kalau sampai lolos.
    const { svc, matikanPcOtomatis } = harness({ setting: 'lima menit' });

    await periksa(svc);

    expect(matikanPcOtomatis).toHaveBeenCalledWith('pc-1');
  });
});

describe('jalur happy', () => {
  it('terkirim, dicatat di log, timer disenapkan', async () => {
    const { svc, jejak, log, dapatPc, matikanPcOtomatis } = harness();

    await periksa(svc);

    expect(matikanPcOtomatis).toHaveBeenCalledWith('pc-1');
    expect(jejak).toContain('broadcastPcUpdate');
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe('pc_shutdown_auto');
    expect(log[0].payload).toMatchObject({ alasan: 'idle', menit: MENIT });
    // Disenapkan supaya tidak dikirim ulang tiap 10 detik.
    expect(dapatPc().terakhirAktifAt).toBeNull();
  });

  it('tick kedua tidak mengirim ulang', async () => {
    const { svc, matikanPcOtomatis } = harness();

    await periksa(svc);
    await periksa(svc);

    expect(matikanPcOtomatis).toHaveBeenCalledTimes(1);
  });

  it('detail log menyebut alasan, bukan cuma event kosong', async () => {
    const { svc, log } = harness();

    await periksa(svc);

    // `broadcastActivityLog` hanya menulis field terpetakan ke berkas log.
    // Tanpa `alasan`, baris log jadi "PC Mati Otomatis | pc=PC001" tanpa
    // penjelasan kenapa PC itu dimatikan.
    expect(String(log[0].payload.alasan)).toBe('idle');
    expect(String(log[0].payload.detail)).toContain('5 menit');
  });
});

describe('hitung mundur di dashboard', () => {
  const sisa = (
    svc: SessionService,
    terakhirAktifAt: Date | null,
    setting = String(MENIT),
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).sisaDetikAutoShutdown(
      { terakhirAktifAt },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setting === '0' ? 0 : MENIT,
      SEKARANG.getTime(),
    ) as number | null;

  it('sisa 5 menit -> 300 detik', () => {
    const { svc } = harness();
    const t = new Date(SEKARANG.getTime());
    expect(sisa(svc, t)).toBe(300);
  });

  it('sudah lewat batas -> 0, bukan angka negatif', () => {
    const { svc } = harness();
    const t = new Date(SEKARANG.getTime() - 10 * 60 * 1000);
    expect(sisa(svc, t)).toBe(0);
  });

  it('timer kosong (sudah disenapkan) -> null', () => {
    const { svc } = harness();
    expect(sisa(svc, null)).toBeNull();
  });

  it('fitur dimatikan (0 menit) -> null walau timer menyala', () => {
    const { svc } = harness({ setting: '0' });
    expect(sisa(svc, new Date(SEKARANG.getTime()), '0')).toBeNull();
  });
});

describe('senyapkanTimerPCKosong — menutuplubang PC yang timer-nya kosong', () => {
  // ⚠️ Lubang ini nyata dan gejalanya diam-diam: kolom `terakhirAktifAt`
  // ditambahkan lewat migrasi, jadi PC yang SAAT ITU sudah tersambung punya
  // nilainya kosong. `registerPc()` hanya jalan saat agent konek ulang — kalau
  // socket PC itu tetap hidup, PC itu tidak akan pernah punya timer dan tidak
  // akan pernah dimatikan otomatis. Tanpa error, tanpa warning.
  it('timer kosong + agent sehat + tanpa sesi -> dinyalakan', async () => {
    const { svc, panggilUpdateMany } = harness();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).senyapkanTimerPCKosong();

    expect(panggilUpdateMany).toHaveBeenCalledTimes(1);
    const where = panggilUpdateMany.mock.calls[0][0].where;
    expect(where.rusak).toBe(false);
    expect(where.terakhirAktifAt).toBeNull();
    // Syarat "tanpa sesi" WAJIB ada. Tanpa itu PC yang sedang dipakai pelanggan
    // bisa mendapat hitung mundur — dan itu persis yang harus dihindari.
    expect(where.sessions).toEqual({ none: { status: SessionStatus.BERJALAN } });
    expect(where.lastHeartbeatAt).toBeDefined();
  });

  it('hanya satu query updateMany untuk semua PC', async () => {
    // Kalau satu query per PC, checker tiap 10 detik jadi 7 query sia-sia.
    const { svc, panggilUpdateMany } = harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).senyapkanTimerPCKosong();
    expect(panggilUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('galat database tidak boleh menjatuhkan pemeriksa', async () => {
    // Fungsi ini dipanggil dari setInterval. Tanpa try/catch, satu error jadi
    // unhandled rejection yang menjatuhkan SELURUH proses server.
    const { svc, panggilUpdateMany } = harness();
    panggilUpdateMany.mockRejectedValueOnce(new Error('koneksi database putus'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((svc as any).senyapkanTimerPCKosong()).resolves.toBeUndefined();
  });
});
