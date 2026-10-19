/**
 * Diagnosis koneksi PC dari dua sinyal independen.
 *
 * 🔴 Menjawab pertanyaan yang sebelumnya tidak bisa dijawab: kenapa heartbeat
 * agent berhenti? Dua jawabannya sangat berbeda, tapi dari `lastHeartbeatAt`
 * saja keduanya terlihat identik:
 *
 * 1. Agent hang. Transport masih balas ping, tapi proses agent berhenti
 *    mengirim. Masalah software, bukan jaringan.
 * 2. Koneksi benar-benar putus. PC mati, reboot, atau jaringan putus.
 *
 * Dua sinyal dari dua tempat berbeda:
 *
 * | Sinyal | Asal | Bukti apa |
 * |---|---|---|
 * | terakhirHeartbeat | event `agent:heartbeat`, tiap 15 detik | proses agent masih mengirim |
 * | terakhirPong | balasan ping engine.io, tiap 25 detik | jalur jaringan masih hidup |
 *
 * ⚠️ Pong SENGAJA tidak memakai event aplikasi `agent:ping`. Socket.IO sudah
 * meng-ping agent tiap 25 detik dan memutus koneksi kalau balasan tidak sampai
 * dalam 20 detik. Itu di level transport, terpisah dari event Socket.IO.
 * Kalau keduanya di level yang sama, satu yang macet akan menyeret yang lain
 * dan tidak ada yang bisa dibedakan.
 *
 * Karena tidak butuh handler baru di agent, fitur ini langsung berlaku untuk
 * semua PC, termasuk yang masih 1.0.24.0 dan belum punya updater.
 */

/** Ambang selisih heartbeat dan pong agar dianggap berdekatan. */
export const AMBANG_BERDEKATAN_MS = 10_000;

/**
 * Berapa lama tanpa heartbeat sebelum suspect.
 *
 * ⚠️ Harus lebih dari dua kali interval heartbeat (15 detik), kalau tidak
 * satu heartbeat telat saja sudah memicu. Sengaja sama dengan
 * `AMBANG_OFFLINE_MS` di `pc-status.ts` supaya keduanya tidak berbeda saat
 * ambangnya bersinggungan.
 */
export const AMBANG_HB_BASIH_MS = 30_000;

/** Berapa lama tanpa pong sebelum jalur transport dianggap putus. */
export const AMBANG_PONG_BASIH_MS = 45_000;

/**
 * Pembeda `PUTUS_BERSAMA` dengan `PUTUS_TIDAK_BERDEKATAN` menentukan boleh
 * tidaknya menyebut kejadian itu "restart biasa", dan itu tidak boleh ditebak:
 *
 * - Dua-duanya basi dan BERDEKATAN -> PC memang mati atau reboot. Wajar.
 * - Dua-duanya basi tapi JAUH -> salah satu berhenti lebih dulu. Itu bukan
 *   restart bersih, dan kalau tetap dilabeli "restart biasa" maka kasus yang
 *   justru paling mencurigakan jadi tidak terlihat.
 */
export type DiagnosisKoneksi =
  | 'HIDUP'
  | 'SUSPICIOUS_AGENT_HANG'
  | 'PUTUS_BERSAMA'
  | 'PUTUS_TIDAK_BERDEKATAN';

export interface SinyalKoneksi {
  readonly terakhirHeartbeat: Date | null;
  readonly terakhirPong: Date | null;
  readonly sekarang?: Date;
}

export interface HasilDiagnosis {
  readonly diagnosis: DiagnosisKoneksi;
  /** Selisih milidetik antara waktu kedua sinyal terakhir. */
  readonly selisihMs: number;
  readonly umurHeartbeatMs: number;
  readonly umurPongMs: number;
}

/**
 * Klasifikasi kondisi koneksi. Fungsi murni tanpa Prisma, tanpa Date.now
 * tersembunyi, dan tanpa efek samping.
 */
export function diagnosisKoneksi(sinyal: SinyalKoneksi): HasilDiagnosis {
  const sekarang = sinyal.sekarang ?? new Date();
  const umurHeartbeatMs = umur(sinyal.terakhirHeartbeat, sekarang);
  const umurPongMs = umur(sinyal.terakhirPong, sekarang);

  const heartbeatBasi = umurHeartbeatMs >= AMBANG_HB_BASIH_MS;
  const pongBasi = umurPongMs >= AMBANG_PONG_BASIH_MS;

  // ⚠️ `!terakhirHeartbeat`, BUKAN `terakhirHeartbeat === null`. Benda uji
  // sebagian bisa membawa `undefined`, dan `undefined === null` bernilai
  // FALSE sehingga baris berikutnya memanggil `.getTime()` pada `undefined`.
  //
  // ⚠️ `keduaSinyalAda` TIDAK boleh disamakan dengan `selisihMs === 0`.
  // `selisihMs` bernilai 0 kalau salah satu sinyal tidak pernah ada, dan nol
  // jelas "berdekatan". PC yang belum pernah konek akan ikut terkira restart
  // bersih kalau tidak dijaga terpisah.
  const keduaSinyalAda = !!sinyal.terakhirHeartbeat && !!sinyal.terakhirPong;
  const selisihMs = keduaSinyalAda
    ? Math.abs(sinyal.terakhirHeartbeat!.getTime() - sinyal.terakhirPong!.getTime())
    : 0;

  let diagnosis: DiagnosisKoneksi;
  if (!heartbeatBasi && !pongBasi) {
    diagnosis = 'HIDUP';
  } else if (heartbeatBasi && !pongBasi) {
    // 🔴 Kasus paling mahal kalau tidak dikenali: socket sehat, agent mati.
    diagnosis = 'SUSPICIOUS_AGENT_HANG';
  } else if (keduaSinyalAda && selisihMs <= AMBANG_BERDEKATAN_MS) {
    // Dua sinyal berhenti hampir bersamaan: PC memang mati atau reboot.
    diagnosis = 'PUTUS_BERSAMA';
  } else {
    // Dua-duanya basi tapi tidak berdekatan, atau salah satunya tidak pernah
    // tercatat. Tidak bisa disebut restart bersih.
    diagnosis = 'PUTUS_TIDAK_BERDEKATAN';
  }

  return { diagnosis, selisihMs, umurHeartbeatMs, umurPongMs };
}

function umur(waktu: Date | null | undefined, sekarang: Date): number {
  if (!waktu) {
    // Tidak pernah ada sinyal sama sekali. `MAX_SAFE_INTEGER` supaya ikut
    // dianggap basi, bukan dianggap baru saja.
    return Number.MAX_SAFE_INTEGER;
  }
  return sekarang.getTime() - waktu.getTime();
}

/**
 * PC yang perlu ditangani manual.
 *
 * ⚠️ `PUTUS_BERSAMA` SENGAJA tidak masuk. PC yang dimatikan operator memang
 * tetap offline sampai agent-nya konek lagi, dan itu normal. Kalau ikut
 * dilaporkan, setiap PC yang sengaja dimatikan akan terbaca sebagai insiden.
 */
export function diagnosisButuhTindakan(h: HasilDiagnosis): boolean {
  return h.diagnosis === 'SUSPICIOUS_AGENT_HANG';
}

/** Kalimat yang bisa dibaca manusia di log. */
export function kalimatDiagnosis(h: HasilDiagnosis): string {
  const hb = Math.round(h.umurHeartbeatMs / 1000);
  const pong = Math.round(h.umurPongMs / 1000);
  // 🔴 Selisih dicetak dengan satu desimal, BUKAN `Math.round` seperti dua
  // umur di atasnya. Pembulatan ke detik membuat selisih 10.001 ms tercetak
  // "10d", padahal ambangnya 10.000 ms -- jadi log menulis "selisih 10d,
  // tidak berdekatan" dan operator mengira angkanya salah baca.
  const selisih = (h.selisihMs / 1000).toFixed(1);

  switch (h.diagnosis) {
    case 'HIDUP':
      return `hidup (heartbeat ${hb}d, pong ${pong}d)`;
    case 'SUSPICIOUS_AGENT_HANG':
      return (
        `PERLU DICIKAT: heartbeat berhenti ${hb}d tapi transport masih balas ` +
        `pong (${pong}d), jadi socket hidup sementara proses agent tidak ` +
        `mengirim. Selisih ${selisih}d.`
      );
    case 'PUTUS_BERSAMA':
      return (
        `koneksi putus (restart/disconnect bersih): heartbeat dan pong ` +
        // ⚠️ Ambang ikut dicetak supaya operator tidak perlu menebak kenapa
        // sebuah selisih disebut berdekatan atau tidak.
        `berhenti berdekatan, selisih ${selisih}d (ambang ${AMBANG_BERDEKATAN_MS / 1000}d) ` +
        `(heartbeat ${hb}d, pong ${pong}d)`
      );
    case 'PUTUS_TIDAK_BERDEKATAN':
      // ⚠️ Kalimat ini sengaja TIDAK memakai kata "restart", walau hanya
      // dalam bentuk negasi. Dengan begitu kesimpulan "PC restart" benar-benar
      // tidak mungkin terbaca dari kalimat ini, dan tes bisa memeriksanya
      // tanpa harus menebak-negasi kalimat yang panjang.
      return (
        `PERLU DICIKAT: heartbeat dan pong keduanya basi tapi tidak berdekatan, ` +
        // ⚠️ Ambang ikut dicetak supaya operator tidak perlu menebak kenapa
        // sebuah selisih disebut berdekatan atau tidak.
        `selisih ${selisih}d (ambang ${AMBANG_BERDEKATAN_MS / 1000}d) ` +
        `(heartbeat ${hb}d, pong ${pong}d). ` +
        `Salah satu berhenti lebih dulu, jadi belum bisa disebut koneksi putus ` +
        `yang bersih.`
      );
  }
}