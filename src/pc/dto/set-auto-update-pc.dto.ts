import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
  // ⚠️ `@IsOptional()` WAJIB ada, dan `@IsString()` saja sudah cukup untuk
  // MENOLAK request yang tidak mengirim `alasan`.
  //
  // `alasan` tidak punya nilai default, jadi ketika tidak dikirim ia `undefined`
  // — dan `@IsString()` menolak `undefined`. Gejalanya: endpoint membalas 400
  // "Alasan maksimal 200 karakter" untuk request yang justru tidak mengirim
  // alasan sama sekali, dan UI yang memanggilnya tidak pernah bisa menyalakan
  // flag sama sekali.
  //
  // Unit test tidak menangkap ini karena memanggil service langsung; yang
  // menolak adalah `ValidationPipe` di lapisan HTTP.
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Alasan maksimal 200 karakter' })
  alasan?: string;
}