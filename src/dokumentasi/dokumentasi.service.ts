import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Menyajikan dokumentasi aplikasi sebagai satu berkas HTML.
 *
 * ⚠️ Dokumen ini TIDAK boleh diletakkan di `frontend/dist`.
 * Folder itu served tanpa autentikasi oleh `ServeStaticModule`, jadi siapa pun
 * yang tahu URL-nya bisa membacanya. Dokumen di sini justru berisi peta
 * struktur database dan cara kerja internal — itu tidak untuk publik.
 * Karena itu penyajiannya lewat endpoint yang wajib JWT + ADMIN.
 */
@Injectable()
export class DokumentasiService {
  private readonly logger = new Logger(DokumentasiService.name);

  /**
   * `process.cwd()` di container backend adalah `/app`, dan `/app` di-bind mount
   * dari folder `backend/` di host. Jadi berkas repo ini terbaca saat runtime
   * tanpa perlu langkah build atau salin manual.
   */
  private readonly jalur = join(process.cwd(), 'dokumentasi', 'index.html');

  /** Berkas bisa saja hilang kalau checkout repo tidak lengkap. Jangan 500. */
  html(): string {
    try {
      return readFileSync(this.jalur, 'utf8');
    } catch (e) {
      this.logger.error(
        `Gagal membaca dokumentasi di ${this.jalur}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new NotFoundException('Berkas dokumentasi tidak ditemukan');
    }
  }
}