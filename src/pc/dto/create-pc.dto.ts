import { IsString, IsNotEmpty, IsIP, IsOptional } from 'class-validator';

export class CreatePcDto {
  @IsString()
  @IsNotEmpty()
  namaPc: string;

  /**
   * Opsional. Tidak perlu diisi manual — server menimpanya otomatis dengan IP
   * yang teramati dari koneksi agent (berganti-ganti bila PC memakai DHCP).
   * Kosong hanya berlaku selama agent belum pernah connect.
   */
  @IsOptional()
  @IsString()
  @IsIP()
  ipClient?: string;
}
