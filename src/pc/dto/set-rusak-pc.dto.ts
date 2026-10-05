import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class SetRusakPcDto {
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  rusak: boolean;

  /**
   * Alasan opsional, mis. "ganti hard disk" atau "mouse rusak".
   *
   * ⚠️ Ini bukan identitas atau kode login, jadi bebas diisi dan tidak
   * disensor. Batas 200 karakter supaya tidak jadi tempat catatan panjang.
   * Diabaikan kalau `rusak` = false — kolomnya dikosongkan.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Alasan maksimal 200 karakter' })
  alasan?: string;
}