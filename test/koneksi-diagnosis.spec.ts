import { describe, expect, it } from 'vitest';
import {
  AMBANG_BERDEKATAN_MS,
  AMBANG_HB_BASIH_MS,
  AMBANG_PONG_BASIH_MS,
  MIN_HANG_BERTAHAN,
  diagnosisButuhTindakan,
  diagnosisKoneksi,
  kalimatDiagnosis,
  type HasilDiagnosis,
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
  });

  it('agen hang yang belum bertahan TIDAK memicu tindakan', () => {
    // 🔴 Diperbaiki setelah DIUKUR. Dari 5 disconnect produksi, 4 punya
    // tahap `SUSPICIOUS_AGENT_HANG` yang persis 10 detik sebelum turun ke
    // `PUTUS_*` -- heartbeat basi di 30 detik, pong basi di 45 detik, jadi
    // disconnect bersih selalu lewat jendela 15 detik itu. Kalau tahap ini
    // langsung berteriak, setiap disconnect normal jadi alarm palsu.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(45),
      terakhirPong: lalu(4),
      sekarang: SEKARANG,
    });
    const bertahanSatu: HasilDiagnosis = { ...h, bertahan: 1 };
    expect(diagnosisButuhTindakan(bertahanSatu)).toBe(false);
  });

  it('agen hang yang bertahan cukup DOES trigger tindakan', () => {
    // Hang sungguhan bertahan: heartbeat basi sementara pong terus mengalir.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(45),
      terakhirPong: lalu(4),
      sekarang: SEKARANG,
    });
    const bertahan: HasilDiagnosis = { ...h, bertahan: MIN_HANG_BERTAHAN };
    expect(diagnosisButuhTindakan(bertahan)).toBe(true);
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

  it('ambang berdekatan 40 detik: tepat di batas masih berdekatan', () => {
    // ⚠️ Angka 40 detik bukan tebakan. Heartbeat tiap 15 detik dan pong tiap
    // 25 detik, keduanya di server -- jadi saat proses agent mati, waktu
    // sinyal terakhirnya bisa jatuh di mana saja dalam rentang 0-40 detik.
    // Selisih 10,5 dan 11,2 detik yang tercatat di produksi DULU diberi label
    // "perlu dicurigai", padahal itu disconnect bersih yang paling sering.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(85),
      terakhirPong: lalu(45),
      sekarang: SEKARANG,
    });
    expect(h.selisihMs).toBe(AMBANG_BERDEKATAN_MS);
    expect(h.diagnosis).toBe('PUTUS_BERSAMA');
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
    // transport yang sama, tapi harus tetap punya jawaban yang jelas.
    //
    // 🔴 Selisihnya 40 detik -- PASPAS sama dengan ambang yang baru. Kalau
    // keadaan ini decide purely lewat aturan selisih, hasilnya "restart
    // bersih" yang jelas salah: transportnya masih rusak. Cabang eksplisit
    // di produksi yang mencegah ini, jadi tesnya dikunci di sini.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(5),
      terakhirPong: lalu(AMBANG_PONG_BASIH_MS / 1000),
      sekarang: SEKARANG,
    });
    expect(h.selisihMs).toBe(40_000);
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

  it('ambang berdekatan: tepat 40 detik masih restart bersih', () => {
    // ⚠️ Batasnya INKLUSIF. Selisih tepat 40.000 ms masih "berdekatan";
    // satu milidetik di atasnya sudah tidak.
    const tepat = diagnosisKoneksi({
      terakhirHeartbeat: lalu(85),
      terakhirPong: lalu(45),
      sekarang: SEKARANG,
    });
    expect(tepat.selisihMs).toBe(AMBANG_BERDEKATAN_MS);
    expect(tepat.diagnosis).toBe('PUTUS_BERSAMA');

    const lewat = diagnosisKoneksi({
      terakhirHeartbeat: lalu(86),
      terakhirPong: lalu(45),
      sekarang: SEKARANG,
    });
    expect(lewat.selisihMs).toBe(41_000);
    expect(lewat.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
  });

  it('selisih yang terukur di produksi tidak lagi salah label', () => {
    // 🔴 Regresi untuk data nyata 19 Okt. Dua dari lima disconnect bersih
    // punya selisih 10,5 dan 11,2 detik, dan ambang lama 10 detik melabeli
    // keduanya "perlu dicurigai". Itu noise pada kejadian yang paling sering.
    for (const selisihDetik of [0.6, 1.8, 9.8, 10.5, 11.2]) {
      const h = diagnosisKoneksi({
        terakhirHeartbeat: lalu(60 + selisihDetik),
        terakhirPong: lalu(60),
        sekarang: SEKARANG,
      });
      expect(h.diagnosis).toBe('PUTUS_BERSAMA');
    }
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

  it('menyatakan agent hang yang bertahan secara eksplisit', () => {
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(45),
      terakhirPong: lalu(4),
      sekarang: SEKARANG,
    });
    const teks = kalimatDiagnosis({ ...h, bertahan: MIN_HANG_BERTAHAN });
    expect(teks).toContain('PERLU DICIKAT');
    expect(teks).toContain('socket hidup');
    // ⚠️ Lamanya juga disebut, supaya operator tahu ini bukan sekali lihat.
    expect(teks).toContain(`${MIN_HANG_BERTAHAN} pemeriksaan berturut`);
  });

  it('agen hang yang masih sesaat TIDAK berteriak', () => {
    // 🔴 Kalau kalimat stage ini mengandi "PERLU DICIKAT", setiap
    // disconnect bersih akan mengulang alarm palsu -- dan operator akan
    // berhenti mempercayai baris ini untuk semua keadaan.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(45),
      terakhirPong: lalu(4),
      sekarang: SEKARANG,
    });
    const teks = kalimatDiagnosis({ ...h, bertahan: 1 });
    expect(teks).not.toContain('PERLU DICIKAT');
    expect(teks).toContain('masih sesaat');
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
    expect(kalimatDiagnosis(berdekatan)).toMatch(/selisih 2\.0d/);
    // ⚠️ Ambang ikut tercetak, jadi operator tidak perlu menghitung sendiri
    // untuk memahami kenapa sebuah selisih disebut berdekatan atau tidak.
    expect(kalimatDiagnosis(berdekatan)).toContain('ambang 40d');

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
    expect(kalimatDiagnosis(h)).toContain('selisih 254.0d');
  });

  it('agen hang tidak diklaim sebagai koneksi putus', () => {
    // ⚠️ Dua kasus ini kelihatan mirip di log kalau selisihnya tidak
    // dicetak. Bahaya arahnya berlawanan: salah baca "koneksi putus" sebagai
    // normal membuat agent hang tidak pernah diburu.
    const h = diagnosisKoneksi({
      terakhirHeartbeat: lalu(300),
      terakhirPong: lalu(10),
      sekarang: SEKARANG,
    });
    expect(h.diagnosis).toBe('SUSPICIOUS_AGENT_HANG');
    // ⚠️ Diuji pada tahap yang MENETAP. Tahap yang sesaat memang sengaja
    // tidak berteriak, jadi di situ kata "PERLU DICIKAT" justru tidak boleh
    // dicari.
    expect(kalimatDiagnosis({ ...h, bertahan: MIN_HANG_BERTAHAN })).toMatch(
      /PERLU DICIKAT/,
    );
    expect(kalimatDiagnosis({ ...h, bertahan: MIN_HANG_BERTAHAN })).not.toMatch(
      /restart/,
    );
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