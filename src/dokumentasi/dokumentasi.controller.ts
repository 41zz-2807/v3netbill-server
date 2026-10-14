import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator.js';
import { DokumentasiService } from './dokumentasi.service.js';

/**
 * Dokumentasi teksis keseluruhan aplikasi (HTML5 + JavaScript).
 *
 * 🔴 Wajib ADMIN. Dokumen ini memuat struktur database, daftar endpoint, path
 * internal, dan prosedur operasional. Semuanya tidak boleh jatuh ke tangan
 * orang yang hanya punya sesi KASIR — atau dibaca siapa pun lewat URL.
 *
 * Dipanggil dari halaman **Pengaturan → Instalasi**, kartu "Dokumentasi Update".
 * Frontend mengambilnya lewat `fetch` dengan header `Authorization` lalu
 * membukanya sebagai blob di tab baru, jadi tidak pernah diekspos sebagai
 * berkas statis yang bisa diakses tanpa login.
 */
@Controller('dokumentasi')
export class DokumentasiController {
  constructor(private readonly dokumentasi: DokumentasiService) {}

  @Get()
  @Roles(Role.ADMIN)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  // ⚠️ `@Res()` WAJIB parameter pertama. Menaruhnya setelah parameter opsional
  // ditolak TypeScript (TS1016), dan karena watcher Nest menunggu compile,
  // satu baris seperti itu menjatuhkan seluruh server.
  async halaman(@Res() res: Response): Promise<void> {
    res.send(this.dokumentasi.html());
  }
}