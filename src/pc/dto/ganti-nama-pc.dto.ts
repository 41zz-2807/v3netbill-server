import { IsString, IsNotEmpty, MaxLength, MinLength } from 'class-validator';

export const MAKS_KARAKTER_NAMA_PC = 30;

/**
 * Ganti nama PC.
 *
 * ⚠️ `namaPc` HANYA label — bukan identitas. Identitas PC selalu `id` (UUID)
 * + `agentToken`, dan tidak ada index unik pada `namaPc`. Jadi mengganti nama
 * tidak memindahkan sesi, tidak memutus agent, dan tidak mengubah token apa pun.
 *
 * Karena itu nama ini jadi PARAMETER UMUM. Yang berubah: label di dashboard,
 * notifikasi, nama berkas log, dan nama berkas diagnosa. Semua itu dibaca ulang
 * dari database, kecuali tiga tempat yang punya cache sendiri — cache log
 * billing dan konfigurasi Nextcloud di agent. Keduanya sengaja dikosongkan /
 * didorong ulang di `PcService.gantiNama()` supaya tidak ada tempat yang
 * tertinggal memakai nama lama.
 */
export class GantiNamaPcDto {
  @IsString()
  @IsNotEmpty({ message: 'Nama PC tidak boleh kosong' })
  @MinLength(1, { message: 'Nama PC tidak boleh kosong' })
  @MaxLength(MAKS_KARAKTER_NAMA_PC, {
    message: `Nama PC maksimal ${MAKS_KARAKTER_NAMA_PC} karakter`,
  })
  namaPc: string;
}