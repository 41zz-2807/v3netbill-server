import { ArrayNotEmpty, IsArray, IsBoolean, IsString, MaxLength } from 'class-validator';

/**
 * Nyalakan / matikan flag pembaruan otomatis untuk BEBERAPA PC sekaligus.
 *
 * ⚠️ Multi-select, bukan per-PC satu-satu, karena operator praktisnya menekan
 * "Perbarui semua PC" saat warnet tutup. Yang tetap dijamin: hanya PC di
 * daftar ini yang tersentuh — PC lain tidak menerima apa pun.
 *
 * ⚠️ Daftar kosong DITOLAK. Menerima `ids: []` membuat "Perbarui 0 PC"
 * terlihat berhasil di tombol, padahal tidak terjadi apa-apa — itu jenis
 * umpan balik palsu yang membuat orang mengira fiturnya selesai.
 */
export class SetAutoUpdatePcDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Pilih minimal satu PC' })
  @IsString({ each: true })
  ids: string[];

  @IsBoolean()
  aktif: boolean;

  /**
   * Alasan opsional, mis. "update keamanan".
   *
   * ⚠️ Dipakai hanya di log aktivitas. Ini bukan kode login, jadi bebas diisi
   * dan tidak disensor.
   */
  @IsString()
  @MaxLength(200, { message: 'Alasan maksimal 200 karakter' })
  alasan?: string;
}