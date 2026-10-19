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

/**
 * Ambang selisih heartbeat dan pong agar dianggap berdekatan.
 *
 * 🔴 Dinaikkan dari 10.000 ke 40.000 setelah DIUKUR di produksi. Data
 * 19 Okt pukul 10:46-13:37 WIB:
 *
 * | Selisih terukur | PC | Diberi label |
 * |---|---|---|
 * | 0,6 dtk | PC004 | `PUTUS_BERSAMA` |
 * | 1,8 dtk | PC004 | `PUTUS_BERSAMA` |
 * | 9,8 dtk | PC007 | `PUTUS_BERSAMA` |
 * | 10,5 dtk | PC002 | `PUTUS_TIDAK_BERDEKATAN` |
 * | 11,2 dtk | PC007 | `PUTUS_TIDAK_BERDEKATAN` |
 *
 * Dua disconnect yang bersih terlabel "perlu dicurigai" hanya karena
 * selisihnya 0,5 dtk di atas ambang lama. Itu bukan kasus tambahan yang
 * terperhatikan -- itu MEMBUKA noise pada disconnect yang paling sering
 * terjadi.
 *
 * ⚠️ Kenapa 40.000 dan bukan 30.000: heartbeat dikirim tiap 15 detik dan pong
 * tiap 25 detik, keduanya di server. Kalau proses agent mati, waktu sinyal
 * terakhirnya jatuh di mana saja dalam rentang 0-40 detik. Angka itu bukan
 * tebakan, itu konsekuensi dari dua interval itu. Dengan 40.000,
 * `PUTUS_TIDAK_BERDEKATAN` menjadi keadaan "tidak bisa dijelaskan" yang
 * memang layak jadi perhatian, bukan tempat separuh disconnect normal
 * mendarat.
 */
export const AMBANG_BERDEKATAN_MS = 40_000;

/**
 * Berapa kali berturut-turut `SUSPICIOUS_AGENT_HANG` harus terlihat sebelum
 * dianggap hang sungguhan.
 *
 * 🔴 Diperbaiki setelah DIUKUR di produksi. Dari 5 disconnect yang tercatat,
 * 4 di antaranya didahului `SUSPICIOUS_AGENT_HANG` persis 10 detik
 * sebelumnya lalu langsung turun ke `PUTUS_*`:
 *
 * ```
 * 10:45:52 PC007 SUSPICIOUS  ->  10:46:22 PC007 PUTUS_TIDAK_BERDEKATAN
 * 10:46:02 PC004 SUSPICIOUS  ->  10:46:12 PC004 PUTUS_BERSAMA
 * 12:47:54 PC004 SUSPICIOUS  ->  12:48:04 PC004 PUTUS_BERSAMA
 * 13:36:54 PC007 SUSPICIOUS  ->  13:37:04 PC007 PUTUS_BERSAMA
 * ```
 *
 * Hang sungguhan mengulang state ini di SETIAP siklus pemeriksaan selama
 * pong masih mengalir. Yang terjadi justru satu kali lalu langsung hilang --
 * artinya itu keadaan sesaat di jalur turun, bukan hang.
 *
 * ⚠️ Kenapa harus ada di sini: heartbeat basi di 30 detik, pong basi di 45
 * detik. Jadi selalu ada jendela 15 detik dengan heartbeat sudah mati tapi pong
 * masih hidup, dan disconnect bersih HARUS lewat jendela itu. Checker
 * berjalan tiap 10 detik, jadi hampir selalu menangkapnya persis satu kali.
 *
 * Dengan 2 pemeriksaan (~20 detik), yang cuma sesaat tidak lagi berteriak.
 */
export const MIN_HANG_BERTAHAN = 2;

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
  /**
   * Berapa kali berturut-turut state ini sudah terlihat pada PC yang sama.
   *
   * ⚠️ Dihitung di service, bukan di sini, karena butuh ingatan antar
   * pemeriksaan. Fungsi ini tetap murni: pemanggil cukup menempelkan
   * angkanya ke hasil.
   *
   * Hanya berarti untuk `SUSPICIOUS_AGENT_HANG`. Lihat `MIN_HANG_BERTAHAN`.
   */
  readonly bertahan?: number;
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
  } else if (!heartbeatBasi) {
    // 🔴 Heartbeat masih hidup tapi pong sudah basi. Kombinasi ini nyaris
    // mustahil secara fisik karena keduanya lewat transport yang sama.
    //
    // ⚠️ Cabang ini WAJIB ada dan harus di SEBELUM aturan selisih. Versi
    // sebelumnya tidak punya, jadi keadaan ini jatuh ke aturan selisih dan
    // selisihnya (40 detik) pas-pas sama dengan ambang yang baru -- hasilnya
    // dilabeli "restart bersih", padahal transport-nya jelas masih rusak.
    // Ketergantungan pada angka membuat klasifikasi berubah hanya karena
    // ambangnya dinaikkan.
    diagnosis = 'PUTUS_TIDAK_BERDEKATAN';
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
 *
 * 🔴 `SUSPICIOUS_AGENT_HANG` hanya butuh tindakan kalau bertahan di
 * `MIN_HANG_BERTAHAN` pemeriksaan berturut-turut. Keterlanjuran hidup
 * 15 detik berarti disconnect bersih yang belum selesai turun -- sering
 * terjadi, dan tidak boleh berteriak tiap kali.
 */
export function diagnosisButuhTindakan(h: HasilDiagnosis): boolean {
  if (h.diagnosis !== 'SUSPICIOUS_AGENT_HANG') {
    return false;
  }
  return (h.bertahan ?? 1) >= MIN_HANG_BERTAHAN;
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
      // 🔴 Dua kalimat yang SANGAT berbeda, dan memilih yang salah akan
      // melatih operator mengabaikan baris ini. Yang belum bertahan
      // sengaja tanpa kata "PERLU DICIKAT": dari 4 disconnect di produksi,
      // semuanya punya tahap ini dan semuanya berujung normal.
      if (!diagnosisButuhTindakan(h)) {
        return (
          `heartbeat berhenti ${hb}d tapi transport masih balas pong ` +
          `(${pong}d); masih sesaat, menunggu pemeriksaan berikutnya. ` +
          `Selisih ${selisih}d.`
        );
      }
      return (
        `PERLU DICIKAT: heartbeat berhenti ${hb}d tapi transport masih balas ` +
        `pong (${pong}d) selama ${h.bertahan} pemeriksaan berturut, jadi ` +
        `socket hidup sementara proses agent tidak mengirim. Selisih ${selisih}d.`
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