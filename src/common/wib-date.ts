/**
 * Batas hari dalam zona WIB.
 *
 * ⚠️ `new Date('2026-10-04')` selalu 00:00 **UTC** (format date-only memang
 * ditulis UTC oleh spesifikasi) = 07:00 WIB, dan database juga menyimpan UTC.
 * Dipakai langsung sebagai batas "dari", filter jadi kehilangan transaksi 7
 * jam pertama setiap hari. Helper ini memakai `Date.UTC`, jadi hasilnya tidak
 * berapa pun `TZ` container (sejak 7 Okt container aplikasi = Asia/Jakarta).
 *
 * `"2026-10-04"` → `2026-10-03T17:00:00.000Z` (00:00 WIB)
 * `sampai` → `2026-10-04T16:59:59.999Z` (23:59 WIB)
 *
 * ⚠️ Batas **hari buku** warnet adalah 23:30 WIB, bukan 00:00. Modul yang
 * memakai batas 23:30 (Reports, ActivityLog, cron tutup-hari) punya hitungannya
 * sendiri dan tidak boleh memakai helper ini.
 */
export const OFFSET_WIB_MS = 7 * 60 * 60 * 1000;

/** Parse `YYYY-MM-DD` jadi batas bawah hari tersebut dalam WIB. */
export function awalHariWib(tanggal: string): Date {
  const [tahun, bulan, hari] = tanggal.split('-').map(Number);
  return new Date(Date.UTC(tahun, bulan - 1, hari, -7, 0, 0, 0));
}

/** Batas atas inklusif hari tersebut dalam WIB (23:59:59.999). */
export function akhirHariWib(tanggal: string): Date {
  const [tahun, bulan, hari] = tanggal.split('-').map(Number);
  return new Date(Date.UTC(tahun, bulan - 1, hari, 16, 59, 59, 999));
}

/** Tanggal hari ini di WIB sebagai `YYYY-MM-DD`. */
export function tanggalWib(now: Date = new Date()): string {
  return new Date(now.getTime() + OFFSET_WIB_MS).toISOString().slice(0, 10);
}
