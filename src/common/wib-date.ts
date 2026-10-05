/**
 * Batas hari dalam zona WIB.
 *
 * ⚠️ Server dan database berjalan di zona UTC, jadi `new Date('2026-10-04')`
 * berarti 00:00 **UTC** = 07:00 WIB. Dipakai langsung sebagai batas "dari",
 * filter jadi kehilangan transaksi 7 jam pertama setiap hari.
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
