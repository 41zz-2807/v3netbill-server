import { IsString, IsNotEmpty } from 'class-validator';

export class PatchSettingDto {
  @IsString()
  @IsNotEmpty()
  key: string;

  // Sengaja TIDAK memakai IsNotEmpty: nilai kosong sah dan dipakai untuk
  // menonaktifkan fitur (mis. kosongkan agent_otp_bot_token → agent kembali
  // ke PIN emergency bawaan). Ini jalur rollback untuk konfigurasi OTP.
  @IsString()
  value: string;
}