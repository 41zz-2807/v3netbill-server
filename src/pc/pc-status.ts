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
 * Status PC yang benar-benar dikirim ke dashboard dan aplikasi mobile.
 *
 * Ada dua sumber yang saling bertentangan, dan karena itu keduanya dipakai:
 *
 * 1. **Heartbeat** — satu-satunya bukti agent masih hidup.
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
 * ⚠️ Sesi **tidak** boleh mengalahkan heartbeat yang basi. Selama grace period
 * masih ada `Session` BERJALAN sementara agent sudah putus; kalau sesinya yang
 * menang, dashboard menampilkan hitung mundur yang tidak lagi bergerak
 * berdampingan dengan tombol Start — di aplikasi billing angka yang salah lebih
 * buruk daripada tidak ditampilkan.
 */
export function statusPcDitampilkan(
  statusKolom: PcStatus,
  lastHeartbeatAt: Date | null,
  adaSesiBerjalan: boolean,
  now: Date = new Date(),
): PcStatus {
  if (!heartbeatSegar(lastHeartbeatAt, now)) {
    return PcStatus.OFFLINE;
  }
  return adaSesiBerjalan ? PcStatus.ACTIVE : statusKolom;
}
