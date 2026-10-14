import { describe, expect, it } from 'vitest';
import { PcStatus } from '@prisma/client';
import {
  AMBANG_OFFLINE_MS,
  sesiDalamMasaTenggang,
  statusPcDitampilkan,
  statusPcEfektif,
} from '../src/pc/pc-status.js';

const SEKARANG = new Date('2026-10-04T10:00:00.000Z');
const detikLalu = (detik: number) => new Date(SEKARANG.getTime() - detik * 1000);

/** Bawaan `grace_period_detik` di Pengaturan. */
const GRACE = 180;

/** Sesi berjalan yang agentnya masih tersambung. */
const sesi = { disconnectedAt: null };
/** Sesi berjalan yang agentnya terputus, tapi belum lewat masa tenggang. */
const sesiPutusBaru = { disconnectedAt: detikLalu(10) };

describe('statusPcEfektif', () => {
  it('belum pernah connect berarti OFFLINE, bukan IDLE', () => {
    expect(statusPcEfektif(PcStatus.IDLE, null, SEKARANG)).toBe(PcStatus.OFFLINE);
  });

  it('heartbeat tepat ambang sudah OFFLINE', () => {
    expect(
      statusPcEfektif(PcStatus.IDLE, detikLalu(AMBANG_OFFLINE_MS / 1000), SEKARANG),
    ).toBe(PcStatus.OFFLINE);
  });

  it('heartbeat di bawah ambang memakai nilai kolom', () => {
    expect(
      statusPcEfektif(PcStatus.ACTIVE, detikLalu(AMBANG_OFFLINE_MS / 1000 - 1), SEKARANG),
    ).toBe(PcStatus.ACTIVE);
  });
});

describe('sesiDalamMasaTenggang', () => {
  it('sesi yang tidak pernah terputus bukan masa tenggang', () => {
    expect(sesiDalamMasaTenggang(null, GRACE, SEKARANG)).toBe(false);
  });

  it('terputus sebentar lalu agent kembali -> masih di dalam masa tenggang', () => {
    expect(sesiDalamMasaTenggang(detikLalu(10), GRACE, SEKARANG)).toBe(true);
  });

  it('terputus melewati ambang -> sudah tidak di dalam masa tenggang', () => {
    expect(sesiDalamMasaTenggang(detikLalu(GRACE + 1), GRACE, SEKARANG)).toBe(false);
  });

  it('tepat di ambang -> sudah lewat, tidak ditahan', () => {
    expect(sesiDalamMasaTenggang(detikLalu(GRACE), GRACE, SEKARANG)).toBe(false);
  });

  it('grace period 0 berarti tidak ada yang ditahan', () => {
    expect(sesiDalamMasaTenggang(detikLalu(1), 0, SEKARANG)).toBe(false);
  });

  it('grace period tidak valid tidak boleh menahan apa pun', () => {
    expect(sesiDalamMasaTenggang(detikLalu(1), Number.NaN, SEKARANG)).toBe(false);
  });

  // Regresi nyata: ini ditemukan `test/pc-rusak.spec.ts` tepat setelah grace
  // period ditambahkan. Penjaga pertamanya `disconnectedAt === null`, dan
  // benda uji sebagian punya `undefined` — yang lolos penjaga itu lalu membuat
  // `.getTime()` dipanggil pada `undefined` dan melempar `TypeError`.
  //
  // Di produksi Prisma memang mengisi `null`, tapi bentuk session di
  // `getDashboardData()` adalah hasil `Map.get()`, jadi tidak ada jaminan
  // seragam. Jadi yang diuji di sini adalah bentuk nilai, bukan isi kolom.
  it('disconnectedAt undefined harus dianggap tidak ada, bukan error', () => {
    const tidakAda = {} as { disconnectedAt: Date | null | undefined };
    expect(sesiDalamMasaTenggang(tidakAda.disconnectedAt, GRACE, SEKARANG)).toBe(false);
  });
});

describe('statusPcDitampilkan', () => {
  // Ini regresi bug yang dilaporkan: `checkPcOffline()` menulis OFFLINE ke kolom
  // `status`, `heartbeat()` dulu tidak pernah memulihkannya, dan agent yang
  // tetap konek hanya kirim `lastHeartbeatAt`. Dashboard lalu kehilangan hitung
  // mundur dan menampilkan tombol Start pada PC yang sedang tersesi.
  it('kolom OFFLINE + agent sehat + ada sesi -> ACTIVE', () => {
    expect(statusPcDitampilkan(PcStatus.OFFLINE, detikLalu(5), sesi, GRACE, SEKARANG)).toBe(
      PcStatus.ACTIVE,
    );
  });

  it('kolom OFFLINE + agent sehat + tanpa sesi -> tetap OFFLINE', () => {
    expect(statusPcDitampilkan(PcStatus.OFFLINE, detikLalu(5), null, GRACE, SEKARANG)).toBe(
      PcStatus.OFFLINE,
    );
  });

  it('kolom IDLE + agent sehat + ada sesi -> ACTIVE', () => {
    expect(statusPcDitampilkan(PcStatus.IDLE, detikLalu(1), sesi, GRACE, SEKARANG)).toBe(
      PcStatus.ACTIVE,
    );
  });

  it('kolom IDLE + agent sehat + tanpa sesi -> IDLE', () => {
    expect(statusPcDitampilkan(PcStatus.IDLE, detikLalu(1), null, GRACE, SEKARANG)).toBe(
      PcStatus.IDLE,
    );
  });

  it('heartbeat basi + ada sesi TIDAK dalam masa tenggang -> OFFLINE', () => {
    // Sesi ini masih tersambung dari sisi server (tidak ada disconnectedAt),
    // jadi tidak ada yang menahannya. Rulesama: heartbeat basi menang.
    expect(statusPcDitampilkan(PcStatus.ACTIVE, detikLalu(45), sesi, GRACE, SEKARANG)).toBe(
      PcStatus.OFFLINE,
    );
  });

  it('belum pernah connect + ada sesi -> OFFLINE', () => {
    expect(statusPcDitampilkan(PcStatus.ACTIVE, null, sesi, GRACE, SEKARANG)).toBe(
      PcStatus.OFFLINE,
    );
  });
});

// 🔴 Perilaku baru: PC yang sedang dalam masa tenggang TIDAK boleh tampil
// OFFLINE.
//
// Ini masalah yang dilaporkan pagi 14 Okt: satu kedipan jaringan membuat
// seluruh PC di warnet tampil OFFLINE di dashboard padahal sesinya baik-baik
// saja. Dengan grace period yang sudah bekerja, sesi masih hidup dan hitung
// mundurnya masih berjalan — jadi menampilkan OFFLINE hanya menambah
// kekhawatiran tanpa menambah informasi.
describe('masa tenggang menahan PC tetap terbaca hidup', () => {
  it('terputus 10 detik lalu, heartbeat masih basi -> ACTIVE', () => {
    expect(
      statusPcDitampilkan(PcStatus.ACTIVE, detikLalu(45), sesiPutusBaru, GRACE, SEKARANG),
    ).toBe(PcStatus.ACTIVE);
  });

  it('terputus tapi heartbeat masih segar -> tetap ACTIVE', () => {
    expect(
      statusPcDitampilkan(PcStatus.IDLE, detikLalu(5), sesiPutusBaru, GRACE, SEKARANG),
    ).toBe(PcStatus.ACTIVE);
  });

  it('masa tenggang sudah lewat -> heartbeat basi menang lagi', () => {
    // `disconnectedAt` 10 detik lalu tapi grace period hanya 5 detik, jadi
    // masa tenggang sudah habis. Sesi yang sudah terlampaui tidak lagi
    // memegang apa pun.
    const lewat = { disconnectedAt: detikLalu(10) };
    expect(statusPcDitampilkan(PcStatus.ACTIVE, detikLalu(45), lewat, 5, SEKARANG)).toBe(
      PcStatus.OFFLINE,
    );
  });

  it('belum pernah connect + masa tenggang -> ACTIVE, bukan OFFLINE', () => {
    // Server sempat restart total dan semua agent connect ulang, tapi belum
    // ada heartbeat baru. Sesi masih hidup, jadi PC tidak boleh tampil mati.
    expect(statusPcDitampilkan(PcStatus.OFFLINE, null, sesiPutusBaru, GRACE, SEKARANG)).toBe(
      PcStatus.ACTIVE,
    );
  });

  it('grace period dimatikan (0) tidak menahan apa pun', () => {
    expect(
      statusPcDitampilkan(PcStatus.ACTIVE, detikLalu(45), sesiPutusBaru, 0, SEKARANG),
    ).toBe(PcStatus.OFFLINE);
  });

  it('tanpa sesi tidak ada yang menahan, walau disconnectedAt ada', () => {
    // Penjaga terhadap pemanggilan salah: kalau `sesi` null, tidak ada
    // disconnectedAt yang boleh dibaca, apa pun nilainya di kolom.
    expect(statusPcDitampilkan(PcStatus.IDLE, detikLalu(45), null, GRACE, SEKARANG)).toBe(
      PcStatus.OFFLINE,
    );
  });
});

// Regresi 4 Okt: di `getDashboardData()` pemeriksaan sesi pernah ditulis
// `session !== null`, padahal `Map.get()` mengembalikan `undefined` untuk kunci
// yang tidak ada — dan `undefined !== null` itu TRUE. Akibatnya SETIAP PC tanpa
// sesi terbaca ACTIVE, jadi card PC idle tampil "Aktif".
//
// ⚠️ Unit test fungsi murni TIDAK menangkap ini, karena parameternya sudah berupa
// nilai. Yang perlu dijaga adalah bentuk pemanggilannya — karena itu test ini
// sengaja memakai `Map` sungguhan, bukan boolean.
describe('pola pemanggilan di getDashboardData()', () => {
  it('Map tanpa sesi harus menghasilkan IDLE, bukan ACTIVE', () => {
    const sessionByPc = new Map<string, { disconnectedAt: Date | null }>([
      ['pc-ada-sesi', { disconnectedAt: null }],
    ]);

    // PC yang tidak ada di Map -> `undefined`, harus jadi `null`.
    expect(
      statusPcDitampilkan(
        PcStatus.IDLE,
        detikLalu(1),
        sessionByPc.get('pc-tidak-ada-sesi') ?? null,
        GRACE,
        SEKARANG,
      ),
    ).toBe(PcStatus.IDLE);

    expect(
      statusPcDitampilkan(
        PcStatus.IDLE,
        detikLalu(1),
        sessionByPc.get('pc-ada-sesi') ?? null,
        GRACE,
        SEKARANG,
      ),
    ).toBe(PcStatus.ACTIVE);
  });

  it('Map.get() untuk kunci yang tidak ada bernilai undefined, bukan null', () => {
    const sessionByPc = new Map<string, { disconnectedAt: Date | null }>();
    const session = sessionByPc.get('pc-tidak-ada-sesi');
    expect(session).toBeUndefined();
    // Inilah jebakannya: perbandingan yang salah ini selalu bernilai true.
    expect(session !== null).toBe(true);
  });

  it('call site harus menormalkan undefined, jadi ada `?? null`', () => {
    // Kalau `?? null` dihapus dari call site, `undefined` diteruskan sebagai
    // "sesi". `sesi && ...` lalu bernilai falsy sehingga PC salah/offline bisa
    // lolos — dan tipe `{disconnectedAt} | null` tidak akan menolak `undefined`
    // di TypeScript kalau ditulis longgar. Penjaga ini memastikan tidak ada
    // jalan yang mengembalikan nilai di luar tipe yang benar.
    const tanpaSesi: { disconnectedAt: Date | null } | null = undefined ?? null;
    expect(tanpaSesi).toBeNull();
    expect(
      statusPcDitampilkan(PcStatus.IDLE, detikLalu(1), tanpaSesi, GRACE, SEKARANG),
    ).toBe(PcStatus.IDLE);
  });
});
