import { describe, expect, it } from 'vitest';
import { UptimeService } from '../src/uptime/uptime.service.js';

/**
 * Tes untuk pencatat uptime PC.
 *
 * Yang paling penting di file ini bukan "angkanya benar", tapi **angka itu
 * tidak berbohong**:
 *
 * 1. **Anti-dobel.** Kalau cron berjalan dua kali, atau backend restart di
 *    tengah jalan, angka tidak boleh bertambah lagi untuk periode yang sama.
 * 2. **Jeda offline tidak terhitung.** PC yang mati 10 menit tidak boleh
 *    menambah 10 menit uptime.
 * 3. **Tidak melebihi 24 jam.** Angka yang lebih besar dari satu hari adalah
 *    bukti ada bug, dan lebih buruk daripada tidak ada angka.
 *
 * ⚠️ Semua tes memakai `dihitungSampai` yang ditentukan eksplisit. Kalau
 * hanya memanggil `catat()` berulang dan berharap, hasilnya hanya bergantung
 * pada kecepatan mesin — itu test yang tidak membuktikan apa pun.
 */

type Baris = {
  pcId: string;
  tanggal: Date;
  detikOnline: number;
  dihitungSampai: Date;
};

const TANGGAL = new Date('2026-10-05T00:00:00.000Z');
const PC_ID = 'pc-1';

function harness({
  /** Heartbeat terakhir; `null` berarti belum pernah konek. */
  heartbeatMsLalu = 0,
  barisAwal = null as Baris | null,
} = {}) {
  let baris: Baris | null = barisAwal;
  const jejak: string[] = [];

  const prisma = {
    pc: {
      findMany: async () => [
        { id: PC_ID, lastHeartbeatAt: heartbeatMsLalu === null ? null : new Date(Date.now() - heartbeatMsLalu) },
      ],
    },
    uptimePc: {
      findUnique: async () => {
        jejak.push('findUnique');
        return baris;
      },
      create: async (args: { data: Baris }) => {
        jejak.push('create');
        baris = args.data;
        return baris;
      },
      update: async (args: { where: unknown; data: Partial<Baris> & { detikOnline?: { increment: number } } }) => {
        jejak.push('update');
        const incr = args.data.detikOnline as unknown as { increment: number } | undefined;
        baris = {
          ...(baris as Baris),
          ...(incr ? { detikOnline: baris!.detikOnline + incr.increment } : {}),
          ...(args.data.detikOnline && !incr ? args.data : {}),
          dihitungSampai: args.data.dihitungSampai ?? baris!.dihitungSampai,
        } as Baris;
        return baris;
      },
      deleteMany: async () => ({ count: 0 }),
    },
  };

  const svc = new UptimeService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
  );
  return { svc, jejak, dapat: () => baris };
}

const detikLalu = (ms: number) => new Date(Date.now() - ms);

describe('pencatatan uptime: anti-dobel', () => {
  it('baris pertama mulai dari 0, bukan menebak sejak tengah malam', async () => {
    const { svc, dapat } = harness({ barisAwal: null });
    await svc.catat();
    expect(dapat()!.detikOnline).toBe(0);
  });

  it('menambah selisih sejak watermark', async () => {
    const { svc, dapat } = harness({
      heartbeatMsLalu: 0,
      barisAwal: { pcId: PC_ID, tanggal: TANGGAL, detikOnline: 0, dihitungSampai: detikLalu(120_000) },
    });
    await svc.catat();
    // 120 detik, toleransi 2 detik untuk waktu eksekusi.
    expect(dapat()!.detikOnline).toBeGreaterThanOrEqual(118);
    expect(dapat()!.detikOnline).toBeLessThanOrEqual(122);
  });

  it('catat() kedua pada saat yang sama menambah ~0, BUKAN 60 lagi', async () => {
    const { svc, dapat } = harness({
      heartbeatMsLalu: 0,
      barisAwal: { pcId: PC_ID, tanggal: TANGGAL, detikOnline: 0, dihitungSampai: detikLalu(120_000) },
    });
    await svc.catat();
    const setelahSatu = dapat()!.detikOnline;
    await svc.catat();
    // Ini inti anti-dobel. Tanpa watermark, angka di sini naik ~60 detik.
    expect(dapat()!.detikOnline - setelahSatu).toBeLessThanOrEqual(2);
  });
});

describe('pencatatan uptime: jeda offline', () => {
  it('PC mati tidak menambah apa pun', async () => {
    const { svc, dapat } = harness({
      heartbeatMsLalu: 120_000, // basi jauh, berarti mati
      barisAwal: { pcId: PC_ID, tanggal: TANGGAL, detikOnline: 500, dihitungSampai: detikLalu(600_000) },
    });
    await svc.catat();
    expect(dapat()!.detikOnline).toBe(500);
  });

  it('tapi watermark tetap dimajukan, supaya jeda tidak dihitung ulang', async () => {
    const { svc, dapat } = harness({
      heartbeatMsLalu: 120_000,
      barisAwal: { pcId: PC_ID, tanggal: TANGGAL, detikOnline: 500, dihitungSampai: detikLalu(600_000) },
    });
    await svc.catat();
    // Kalau watermark tidak dimajukan, tick berikutnya akan menghitung
    // 600 detik offline itu sebagai uptime — tepat kesalahan yang paling
    // paling merusak angka ini.
    expect(dapat()!.dihitungSampai.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('PC yang belum pernah konek (heartbeat null) tidak dihitung', async () => {
    const { svc, dapat } = harness({
      heartbeatMsLalu: null,
      barisAwal: { pcId: PC_ID, tanggal: TANGGAL, detikOnline: 0, dihitungSampai: detikLalu(600_000) },
    });
    await svc.catat();
    expect(dapat()!.detikOnline).toBe(0);
  });
});

describe('pencatatan uptime: batas 24 jam', () => {
  it('tidak pernah melebihi 86.400 detik', async () => {
    const { svc, dapat } = harness({
      heartbeatMsLalu: 0,
      barisAwal: { pcId: PC_ID, tanggal: TANGGAL, detikOnline: 86_390, dihitungSampai: detikLalu(600_000) },
    });
    await svc.catat();
    expect(dapat()!.detikOnline).toBeLessThanOrEqual(86_400);
  });
});

describe('pencatatan uptime: ketahanan', () => {
  it('galat database tidak menjatuhkan proses', async () => {
    // `catat()` dipanggil dari setInterval. Tanpa try/catch, satu error jadi
    // unhandled rejection yang menjatuhkan SELURUH proses server — bukan cuma
    // satu PC.
    const svc = new UptimeService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        pc: {
          findMany: async () => {
            throw new Error('koneksi database putus');
          },
        },
      } as any,
    );
    await expect(svc.catat()).resolves.toBeUndefined();
  });

  it('galat saat satu PC gagal tidak menghentikan PC lain', async () => {
    let dipanggil = 0;
    const svc = new UptimeService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        pc: {
          findMany: async () => [
            { id: 'pc-1', lastHeartbeatAt: new Date() },
            { id: 'pc-2', lastHeartbeatAt: new Date() },
          ],
        },
        uptimePc: {
          findUnique: async () => {
            dipanggil++;
            if (dipanggil === 1) throw new Error('kena limit koneksi');
            return null;
          },
          create: async () => ({}),
          update: async () => ({}),
        },
      } as any,
    );
    // Tidak melempar = PC kedua tetap diproses.
    await expect(svc.catat()).resolves.toBeUndefined();
    expect(dipanggil).toBe(2);
  });
});
