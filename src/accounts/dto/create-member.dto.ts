import { IsString, IsNotEmpty, IsInt, Min, IsNumber, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { MAKS_KARAKTER_NAMA, MIN_KARAKTER_NAMA } from '../nama-member.js';

export class CreateMemberDto {
  @IsString()
  @IsNotEmpty()
  // ⚠️ Nama member adalah KREDENSIAL LOGIN-nya (`session.service.ts` mencocokkan
  // `nama`), jadi nama yang terlalu pendek atau terlalu panjang bisa jadi masalah
  // keamanan maupun ketuker. Batas bawah mencegah nama 1-3 karakter yang mudah
  // ditebak orang lain di warnet. Akun yang sudah terlanjur dibuat tidak
  // disentuh — validasi ini hanya berlaku untuk pembuatan baru.
  @MinLength(MIN_KARAKTER_NAMA, {
    message: `Nama member minimal ${MIN_KARAKTER_NAMA} karakter`,
  })
  @MaxLength(MAKS_KARAKTER_NAMA, {
    message: `Nama member maksimal ${MAKS_KARAKTER_NAMA} karakter`,
  })
  nama: string;

  // `password` sengaja tidak ada di sini. Semua member baru mendapat password
  // bawaan yang sama, dan pelanggan bisa menggantinya sendiri dari layar PC
  // lewat tombol "Buat Password" di agent.
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(500)
  nominal: number;
}
