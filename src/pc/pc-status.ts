import { PcStatus } from '@prisma/client';

/**
 * Ambang heartbeat sebelum sebuah PC dianggap OFFLINE.
 *
 * Agent PC mengirim `agent:heartbeat` setiap 15 detik
 * (`HEARTBEAT_INTERVAL_DETIK` di Agent.Core/ServerConnection.cs). Jadi 30 detik
 * berarti dua heartbeat hilang berturut-turut, cukup untuk membedakan koneksi
 * yang putus dari ganggu sesaat.
 *
 * ⚠️ Kalau angka ini diubah di sini, samakan dengan interval heartbeat di
 * agent. Ambang yang terlalu kecil membuat PC yang hanya sesaat lambat/network
 * flaky ikut terbaca OFFLINE, dan operator tidak bisa memulai sesi.
 */
export const AMBANG_OFFLINE_MS = 30_000;

/**
 * Heartbeat dianggap hidup kalau tidak null dan belum melewati ambang.
 *
 * Dipisah dari nilai kolom `status` karena keduanya menunjuk hal berbeda:
 * `lastHeartbeatAt` adalah bukti agent masih hidup, sedangkan kolom `status`
 * cuma cache yang bisa tertinggal.
 */
function heartbeatSegar(lastHeartbeatAt: Date | null, now: Date): boolean {
  if (lastHeartbeatAt === null) {
    return false;
  }
  return now.getTime() - lastHeartbeatAt.getTime() < AMBANG_OFFLINE_MS;
}

/**
 * Status PC berdasarkan heartbeat saja, tanpa melihat sesi.
 *
 * `lastHeartbeatAt` adalah satu-satunya bukti bahwa agent masih hidup, jadi
 * inilah yang menentukan OFFLINE. `lastHeartbeatAt: null` juga berarti OFFLINE,
 * bukan IDLE — PC yang belum pernah connect tidak punya bukti hidup.
 *
 * ⚠️ Kolom `Pc.status` **bisa** berisi OFFLINE: `checkPcOffline()` menuliskannya
 * tiap 10 detik kalau heartbeat basi. Jadi nilai kolom ini tidak boleh
 * dipercayai apa adanya — lihat `statusPcDitampilkan()`.
 */
export function statusPcEfektif(
  status: PcStatus,
  lastHeartbeatAt: Date | null,
  now: Date = new Date(),
): PcStatus {
  return heartbeatSegar(lastHeartbeatAt, now) ? status : PcStatus.OFFLINE;
}

/**
 * Sesi sedang dalam masa tenggang: agent sempat terputus, tapi belum terlampaui.
 *
 * Selama masa tenggang ini sesi **masih hidup** dan hitung mundurnya **masih
 * berjalan** di server — `setInterval` tick-nya tidak bergantung pada socket,
 * jadi waktu pelanggan tetap terpakai dengan benar. Yang mati hanyalah
 * koneksinya, dan itu bisa pulih sendiri.
 *
 * ⚠️ Grace period 0 atau bukan angka berarti fiturnya dimatikan, jadi TIDAK
 * ada yang ditahan. Tanpa ini, PC yang hidup tapi fiturnya mati akan tampil
 * OFFLINE selama 30 detik hanya karena satu heartbeat yang telat.
 */
export function sesiDalamMasaTenggang(
  disconnectedAt: Date | null,
  gracePeriodDetik: number,
  now: Date = new Date(),
): boolean {
  // ⚠️ `!disconnectedAt`, BUKAN `disconnectedAt === null`. Keduanya menagih
  // jebakan yang sama seperti `Map.get()` di `getDashboardData()`: kalau
  // kolomnya `undefined` (benda uji sebagian, atau objek yang belum lengkap),
  // perbandingan dengan `null` bernilai FALSE dan baris berikutnya langsung
  // memanggil `.getTime()` pada `undefined` — error runtime, bukan sekadar
  // status yang salah.
  if (!disconnectedAt) {
    return false;
  }
  if (!Number.isFinite(gracePeriodDetik) || gracePeriodDetik <= 0) {
    return false;
  }
  return now.getTime() - disconnectedAt.getTime() < gracePeriodDetik * 1000;
}

/**
 * Status PC yang benar-benar dikirim ke dashboard dan aplikasi mobile.
 *
 * Ada dua sumber yang saling bertentangan, dan karena itu keduanya dipakai:
 *
 * 1. **Heartbeat** — bukti agent masih hidup.
 * 2. **Sesi yang sedang berjalan** — fakta bahwa PC sedang dipakai.
 *
 * `checkPcOffline()` menulis OFFLINE ke kolom `status`, dan yang mengembalikannya
 * hanya `registerPc()` (reconnect agent) serta `heartbeat()`. Kalau heartbeat
 * tertinggal satu kali (>30 detik) tanpa memutus socket, kolomnya tertinggal
 * OFFLINE padahal agentnya sehat — dan karena `statusPcEfektif()` mengembalikan
 * nilai kolom itu apa adanya, dashboard kehilangan hitung mundur, tombol Start
 * muncul di PC yang sedang tersesi, dan Start itu selalu ditolak dengan
 * "PC sudah memiliki sesi berjalan".
 *
 * 🔴 **Sesi DALAM MASA TENGGANG mengalahkan heartbeat yang basi.** Ini kebalikan
 * dari keputusan lama, dan sekarang justru benar: dengan grace period yang
 * bekerja, sesi masih hidup dan hitung mundurnya masih berjalan, sehingga tidak
 * ada angka salah yang ditampilkan. Tanpa ini, satu kedipan jaringan membuat
 * seluruh PC di warnet tampil OFFLINE selama hampir 3 menit padahal sesinya
 * baik-baik saja — dan itu persis yang terjadi setiap kali server restart.
 *
 * ⚠️ Tapi begitu masa tenggang **lewat**, aturan lama berlaku lagi: heartbeat
 * basi menang dan PC ditampilkan OFFLINE. Sesi yang sudah terlampaui tidak lagi
 * memegang apa pun.
 */
export function statusPcDitampilkan(
  statusKolom: PcStatus,
  lastHeartbeatAt: Date | null,
  sesi: { disconnectedAt: Date | null } | null,
  gracePeriodDetik: number,
  now: Date = new Date(),
): PcStatus {
  if (sesi && sesiDalamMasaTenggang(sesi.disconnectedAt, gracePeriodDetik, now)) {
    return PcStatus.ACTIVE;
  }
  if (!heartbeatSegar(lastHeartbeatAt, now)) {
    return PcStatus.OFFLINE;
  }
  return sesi ? PcStatus.ACTIVE : statusKolom;
}
