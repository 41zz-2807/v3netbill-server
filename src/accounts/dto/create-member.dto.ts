import { IsString, IsNotEmpty, IsInt, Min, IsNumber } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateMemberDto {
  @IsString()
  @IsNotEmpty()
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
