/**
 * Perhitungan energi & biaya listrik dari uptime.
 *
 * ⚠️ Semua fungsi di file ini PURE dan tidak menyentuh database, supaya bisa
 * diuji tanpa Prisma. Tidak ada satu pun angka tariff yang ditulis langsung
 * di sini — semuanya lewat parameter, dan pemanggil membacanya dari `Setting`.
 */

/** Tarif listrik PLN golongan rumah tangga 1.300-2.200 VA (Rp/kWh).
 *
 * ⚠️ Angka ini CUMA fallback. Sumber kebenaran ada di `Setting.harga_per_kwh`,
 * karena tarif PLN ditinjau tiap kuartal dan bisa naik — kalau tarifnya
 * ditulis di sini, biaya yang tampil diam-diam jadi tidak benar tanpa ada
 * error sama sekali.
 *
 * 2.200 VA bukan berarti 2.200 watt. VA itu kapasitas sambungan meter; satu
 * PC warnet hanya menarik 150-300 W. Memakai angka VA sebagai watt membuat
 * biaya terlihat ~10x lebih besar dari kenyataan.
 */
export const TARIF_KWH_DEFAULT = 1444.7;

export const WATT_PC_DEFAULT = 150;

/** Detik dalam satu jam. */
const DETIK_PER_JAM = 3600;

/**
 * kWh dari satu PC.
 *
 * watt / 1000 = kW (daya), dikali jam = kWh.
 *
 * ⚠️ `detik` adalah waktu **nyala** (heartbeat agent diterima), bukan waktu
 * dipakai pelanggan. PC yang menyala di layar kunci tetap menarik listrik,
 * jadi ini estimasi yang benar untuk tagihan — bukan cuma sesi yang dibayar.
 */
export function hitungKwh(detikOnline: number, watt: number): number {
  if (!Number.isFinite(detikOnline) || detikOnline <= 0) return 0;
  if (!Number.isFinite(watt) || watt <= 0) return 0;
  return (watt * detikOnline) / 1000 / DETIK_PER_JAM;
}

/** Rupiah dari kWh dan tarif per kWh. */
export function hitungRupiah(kwh: number, tarifPerKwh: number): number {
  if (!Number.isFinite(kwh) || kwh <= 0) return 0;
  if (!Number.isFinite(tarifPerKwh) || tarifPerKwh <= 0) return 0;
  return kwh * tarifPerKwh;
}

/**
 * Baca tarif per kWh dari `Setting`, dengan fallback kalau kosong / rusak.
 *
 * ⚠️ Tidak pernah melempar. `Setting` yang berisi `NaN` membuat
 * `hitungRupiah()` mengembalikan 0 untuk semua PC — biaya terlihat "Rp 0"
 * tanpa tanda error, yang jauh lebih menyesatkan daripada tarif default.
 */
export function tarifDariSetting(nilaiMentah: string | null | undefined): number {
  const angka = Number.parseFloat((nilaiMentah ?? '').replace(',', '.'));
  if (!Number.isFinite(angka) || angka <= 0) return TARIF_KWH_DEFAULT;
  return angka;
}

/** Daya PC dari database, dengan fallback kalau kolomnya belum terisi. */
export function wattDariPc(nilaiMentah: number | null | undefined): number {
  return typeof nilaiMentah === 'number' && nilaiMentah > 0 ? nilaiMentah : WATT_PC_DEFAULT;
}
