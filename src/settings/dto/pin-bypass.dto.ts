import { IsString } from 'class-validator';

export class PinBypassDto {
  // Boleh kosong: PIN dikosongkan berarti hapus hash dan client kembali ke
  // PIN emergency bawaan.
  @IsString()
  pin: string;
}
