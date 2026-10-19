import { describe, expect, it } from 'vitest';
import {
  AMBANG_BERDEKATAN_MS,
  AMBANG_HB_BASIH_MS,
  AMBANG_PONG_BASIH_MS,
  diagnosisButuhTindakan,
  diagnosisKoneksi,
  kalimatDiagnosis,
} from '../src/pc/koneksi-diagnosis.js';

/**
 * Tes diagnosis koneksi dari dua sinyal.
 *
 * Yang diuji di sini adalah hal yang SEBELUMNYA tidak bisa dibedakan sama
 * sekali: "heartbeat agent berhenti" bisa berarti agent hang (socket sehat)
 * atau koneksi benar-benar putus (PC mati/reboot). Tanpa dua sinyal itu,
 * keduanya menghasilkan gejala dashboard dan baris log yang persis sama.
 *
 * Semua waktu dibuat tetap lewat `sekarang`, jadi tidak ada `Date.now()`
 * tersembunyi dan tidak ada ketergantungan jaringan.
 */

const SEKARANG = new Date('2026-10-18T12:00:00.000Z');

/** Waktu tetap, mundur sebanyak hitungan detik dari titik di atas. */
function lalu(detik: number): Date {
  return new Date(SEKARANG.getTime() - detik * 1000);
}

describe('diagnosisKoneksi', () => {
  it('sehat ketika dua-duanya baru saja datang', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(3),
      terakhirPong: lalu(2),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('HIDUP');
    expect(diagnosisButuhTindakan(h)).toBe(false);
  });

  it('sehat pada heartbeat 14 detik: masih di bawah ambang 30', () => {
    // ⚠️ Ini yang sering dikira salah. Heartbeat agent tiap 15 detik, jadi
    // heartbeat yang berumur 14 detik itu normal, bukan suspect.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(14),
      terakhirPong: lalu(12),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('HIDUP');
  });

  it('agen hang: heartbeat basi tapi pong masih segar', () => {
    // 🔴 Kasus yang paling mahal kalau tidak dikenali.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(45),
      terakhirPong: lalu(4),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('SUSPICIOUS_AGENT_HANG');
    expect(diagnosisButuhTindakan(h)).toBe(true);
  });

  it('putus bersama: heartbeat dan pong basi berdekatan', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(50),
      terakhirPong: lalu(48),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('PUTUS_BERSAMA');
    // ⚠️ Restart yang bersih TIDAK boleh memicu tindakan: PC yang sengaja
    // dimatikan kasir juga offline.
    expect(diagnosisButuhTindakan(h)).toBe(false);
  });

  it('selisih dua sinyal dihitung dalam milidetik absolut', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(60),
      terakhirPong: lalu(50),
      sekarang: SEKARANG,
    });
    expect(h.selisihMs).toBe(10_000);
    expect(h.selisihMs).toBeLessThanOrEqual(AMBANG_BERDEKATAN_MS);
  });

  it('ambang berdekatan 10 detik: tepat di batas masih berdekatan', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(60),
      terakhirPong: lalu(50),
      sekarang: SEKARANG,
    });
    expect(h.selisihMs).toBe(AMBANG_BERDEKATAN_MS);
  });

  it('tidak ada sinyal sama sekali dianggap basi, bukan dianggap baru', () => {
    // ⚠️ `null` berarti tidak pernah ada bukti hidup sama sekali. Kalau ini
    // dianggap "baru saja", PC yang belum pernah konek akan terbaca sehat.
    //
    // 🔴 Dan karena tidak ada salah satu pun yang tercatat, "berdekatan" tidak
    // bisa dinilai. Kalau selisihnya dianggap 0 lalu langsung dikira restart
    // bersih, PC yang belum pernah konek akan dilaporkan sebagai restart biasa.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: null,
      terakhirPong: null,
      sekarang: SEKARANG,
    });
    expect(h.umurHeartbeatMs).toBeGreaterThanOrEqual(AMBANG_HB_BASIH_MS);
    expect(h.umurPongMs).toBeGreaterThanOrEqual(AMBANG_PONG_BASIH_MS);
    expect(h.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
    expect(diagnosisButuhTindakan(h)).toBe(false);
  });

  it('satu sinyal hilang tidak boleh dikira restart bersih', () => {
    // ⚠️ Hanya heartbeat yang pernah tercatat. `selisihMs` bernilai 0 di sini
    // karena salah satu sinyal kosong, dan nol berarti "berdekatan" kalau
    // tidak dijaga terpisah.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(60),
      terakhirPong: null,
      sekarang: SEKARANG,
    });
    expect(h.selisihMs).toBe(0);
    expect(h.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
  });

  it('nilai undefined tidak membuat fungsi melempar', () => {
    // ⚠️ Benda uji sebagian dan objek yang belum lengkap bisa membawa
    // `undefined`, bukan `null`. `undefined === null` bernilai FALSE, jadi
    // penjaga harus memakai `!nilai`, bukan perbandingan dengan `null`.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: undefined as unknown as null,
      terakhirPong: undefined as unknown as null,
      sekarang: SEKARANG,
    });
    expect(Number.isFinite(h.selisihMs)).toBe(true);
    expect(h.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
  });

  it('ambang heartbeat 30 detik: tepat di ambang sudah basi', () => {
    const tepat = diagnosisKoneksi({
      terakhirHeartbeat: lalu(AMBANG_HB_BASIH_MS / 1000),
      terakhirPong: lalu(1),
      sekarang: SEKARANG,
    });
    expect(tepat.diagnosis).toBe('SUSPICIOUS_AGENT_HANG');
  });

  it('ambang pong 45 detik: heartbeat masih hidup tapi transport basi', () => {
    // Ping server tiap 25 detik, jadi 45 detik berarti satu pong hilang.
    // Kombinasi ini nyaris mustahil secara fisik karena heartbeat juga lewat
    // transport yang sama, tapi harus tetap punya jawaban yang jelas. Selisihnya
    // 40 detik, jauh dari ambang, jadi bukan restart bersih.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(5),
      terakhirPong: lalu(AMBANG_PONG_BASIH_MS / 1000),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
  });

  it('dua sinyal basi tapi jauh terpisah TIDAK boleh disebut restart bersih', () => {
    // 🔴 Ini keadaan yang paling mudah hilang kalau ambangnya tidak dipakai.
    // Dua-duanya jelas sudah mati, jadi tanpa melihat selisihnya kesimpulan
    // "PC mati" tetap benar. Tapi itu belum semuanya: selisih 254 detik
    // berarti heartbeat ATAU pong berhenti jauh lebih dulu, dan itu tidak
    // terjadi pada restart yang bersih. Kalau keadaan ini dilabeli "restart
    // biasa" begitu saja, kasus yang justru paling mencurigakan jadi tidak
    // terlihat.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(300),
      terakhirPong: lalu(46),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
    expect(h.selisihMs).toBe(254_000);
    expect(h.selisihMs).toBeGreaterThan(AMBANG_BERDEKATAN_MS);
    // Dicatat, tapi tidak memicu tindakan otomatis apa pun.
    expect(diagnosisButuhTindakan(h)).toBe(false);
    expect(kalimatDiagnosis(h)).toContain('PERLU DICIKAT');
  });

  it('ambang berdekatan: tepat 10 detik masih dianggap restart bersih', () => {
    // ⚠️ Batasnya INKLUSIF. Selisih tepat 10.000 ms masih "berdekatan";
    // satu milidetik di atasnya sudah tidak.
    const tepat = diagnosisKoneksi({
      terakhirHeartbeat: lalu(60),
      terakhirPong: lalu(50),
      sekarang: SEKARANG,
    });
    expect(tepat.selisihMs).toBe(AMBANG_BERDEKATAN_MS);
    expect(tepat.diagnosis).toBe('PUTUS_BERSAMA');

    const lewat = diagnosisKoneksi({
      terakhirHeartbeat: lalu(60),
      terakhirPong: lalu(49),
      sekarang: SEKARANG,
    });
    expect(lewat.selisihMs).toBe(11_000);
    expect(lewat.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
  });
});

describe('kalimatDiagnosis', () => {
  it('menyebut kedua umur untuk keadaan sehat', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(3),
      terakhirPong: lalu(2),
      sekarang: SEKARANG,
    });
    const teks = kalimatDiagnosis(h);
    expect(teks).toContain('hidup');
    expect(teks).toContain('heartbeat 3d');
    expect(teks).toContain('pong 2d');
  });

  it('menyatakan agent hang secara eksplisit', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(45),
      terakhirPong: lalu(4),
      sekarang: SEKARANG,
    });
    const teks = kalimatDiagnosis(h);
    expect(teks).toContain('PERLU DICIKAT');
    expect(teks).toContain('socket hidup');
  });

  it('hanya menyebut restart kalau dua-duanya memang berdekatan', () => {
    // 🔴 Aturannya berubah, dan arah yang dijaga adalah yang lebih berbahaya.
    // Versi lama melarang keras menyebut "restart" karena tidak ada bukti.
    // Sekarang ambangnya dipakai: yang berdekatan BOLEH disebut restart
    // atau disconnect bersih, dan yang tidak berdekatan justru TIDAK BOLEH.
    // Salah di arah kedua lebih berbahaya, karena "PC restart" yang
    // keliru membuat orang berhenti mencarinya.
    const berdekatan = diagnosisKoneksi({
      terakhirHeartbeat: lalu(50),
      terakhirPong: lalu(48),
      sekarang: SEKARANG,
    });
    expect(kalimatDiagnosis(berdekatan)).toMatch(/restart/);
    expect(kalimatDiagnosis(berdekatan)).toMatch(/selisih 2d/);

    const tidakBerdekatan = diagnosisKoneksi({
      terakhirHeartbeat: lalu(300),
      terakhirPong: lalu(46),
      sekarang: SEKARANG,
    });
    expect(kalimatDiagnosis(tidakBerdekatan)).not.toMatch(/restart/);
    expect(kalimatDiagnosis(tidakBerdekatan)).toContain('PERLU DICIKAT');
  });

  it('menyertakan selisih pada koneksi yang tidak berdekatan', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(300),
      terakhirPong: lalu(46),
      sekarang: SEKARANG,
    });
    expect(kalimatDiagnosis(h)).toContain('selisih 254d');
  });

  it('agen hang tidak diklaim sebagai koneksi putus', () => {
    // ⚠️ Dua kasus ini kelihatan mirip di log kalau selisihnya tidak
    // dicetak. Bahayanya arahnya berlawanan: salah baca "koneksi putus" sebagai
    // normal membuat agent hang tidak pernah diburu.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(300),
      terakhirPong: lalu(10),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('SUSPICIOUS_AGENT_HANG');
    expect(kalimatDiagnosis(h)).toMatch(/PERLU DICIKAT/);
  });
});

describe('ambang', () => {
  it('ambang pong lebih besar dari ambang heartbeat', () => {
    // ⚠️ Ini yang membuat "agent hang" bisa terdeteksi. Kalau keduanya sama,
    // heartbeat basi akan selalu ikut Pong basi dan kasus itu tidak pernah
    // muncul sama sekali.
    expect(AMBANG_PONG_BASIH_MS).toBeGreaterThan(AMBANG_HB_BASIH_MS);
  });
});