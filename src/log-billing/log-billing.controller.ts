import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import {
  IsiLog,
  LogBillingService,
  RingkasanLog,
} from './log-billing.service.js';

/**
 * Baca log aktivitas billing.
 *
 * ADMIN saja. Isi log berisi kode voucher, nama member, dan nilai transaksi,
 * jadi ini bukan bahan yang boleh dilihat kasir.
 */
@Controller('log-billing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class LogBillingController {
  constructor(private readonly service: LogBillingService) {}

  @Get()
  async daftar(): Promise<RingkasanLog[]> {
    return this.dapatAtauTolak(() => this.service.daftar());
  }

  @Get(':tanggal')
  async baca(
    @Param('tanggal') tanggal: string,
    @Query('cari') cari?: string,
  ): Promise<IsiLog> {
    return this.dapatAtauTolak(() => this.service.baca(tanggal, cari));
  }

  @Get(':tanggal/unduh')
  async unduh(
    @Param('tanggal') tanggal: string,
    @Res() res: Response,
  ): Promise<void> {
    // `await` wajib: `dapatAtauTolak` sudah async, tanpa await hasilnya
    // masih Promise dan `hasil.nama` tidak ada.
    const hasil = await this.dapatAtauTolak(() => this.service.unduh(tanggal));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${hasil.nama}"`);
    res.send(hasil.isi);
  }

  /**
   * Tanggal tidak sah harus jadi 400 dengan pesan jelas, bukan 500.
   *
   * Parameter `tanggal` datang dari URL dan berakhir jadi nama berkas, jadi
   * errornya harus terlihat oleh orang yang mengetik, bukan tersembunyi di log
   * server sebagai "Internal Server Error".
   */
  private async dapatAtauTolak<T>(aksi: () => Promise<T> | T): Promise<T> {
    try {
      return await aksi();
    } catch (e) {
      if (e instanceof Error && e.name === 'TanggalLogTidakSah') {
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }
}
