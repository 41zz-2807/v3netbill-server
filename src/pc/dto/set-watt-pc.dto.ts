import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * Daya listrik PC dalam watt.
 *
 * ⚠️ INI watt, bukan VA. Meter rumah 2.200 VA itu kapasitas sambungan —
 * kalau angka itu dipakai di sini, biaya listrik yang tampil jadi sekitar 10x
 * lipat lebih besar dari kenyataan, karena satu PC warnet hanya menarik
 * 150-300 W sementara VA adalah batas maksimum, bukan pemakaian nyata.
 *
 * Batas atas longgar (1000 W) supaya PC dengan spek tinggi tetap bisa
 * dicatat, tapi cukup untuk mencakup semua PC warnet.
 */
export class SetWattPcDto {
  @Type(() => Number)
  @IsInt({ message: 'Daya harus berupa angka bulat' })
  @Min(1, { message: 'Daya minimal 1 watt' })
  @Max(1000, { message: 'Daya maksimal 1000 watt' })
  watt: number;
}
