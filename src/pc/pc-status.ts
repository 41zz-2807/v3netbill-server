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
 * Status PC yang benar-benar ditampilkan.
 *
 * Kolom `Pc.status` di database tidak pernah diubah jadi OFFLINE. Field itu
 * hanya diisi `ACTIVE` atau `IDLE` saat agent register dan saat sesi
 * started/stopped, jadi PC yang dimatikan masih menampilkan status lamanya
 * selamanya. Satu-satunya yang tahu apakah agent masih hidup adalah
 * `lastHeartbeatAt`, jadi status yang ditampilkan harus dihitung ulang dari
 * sana setiap kali dibaca.
 *
 * Ini juga berlaku untuk PC yang belum pernah connect: `lastHeartbeatAt` null
 * berarti tidak ada bukti pernah hidup, jadi tidak boleh tampil IDLE.
 */
export function statusPcEfektif(
  status: PcStatus,
  lastHeartbeatAt: Date | null,
  now: Date = new Date(),
): PcStatus {
  if (lastHeartbeatAt === null) {
    return PcStatus.OFFLINE;
  }
  if (now.getTime() - lastHeartbeatAt.getTime() >= AMBANG_OFFLINE_MS) {
    return PcStatus.OFFLINE;
  }
  return status;
}
