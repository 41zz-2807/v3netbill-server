import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body untuk mendaftarkan token perangkat.
 *
 * Tidak ada field `role`: role selalu dibaca dari JWT, bukan dari permintaan.
 * Kalau ada, kasir cukup mengirim role ADMIN untuk mendaftarkan dirinya sebagai
 * penerima notifikasi admin.
 */
export class DaftarTokenDto {
  @IsString()
  @IsNotEmpty()
  // Token FCM sekitar 150 karakter. Batas ini hanya penjaga tampilan, FCM
  // sendiri yang memutuskan token itu valid atau tidak.
  @MaxLength(512)
  token!: string;
}
