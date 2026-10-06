import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { UptimeQueryService } from './uptime-query.service.js';
import { UptimePdfService } from './uptime-pdf.service.js';
import { tanggalWib } from '../common/wib-date.js';

/**
 * Laporan uptime PC — berapa lama tiap PC menyala, dihitung dari heartbeat.
 *
 * ⚠️ Tidak ada data historis. `Pc.lastHeartbeatAt` hanya menyimpan heartbeat
 * terakhir (ditimpa tiap 15 detik), dan `handleConnection`/`handleDisconnect`
 * tidak menulis apa pun ke database. Jadi angka ini baru ada mulai dari saat
 * pencatat dijalankan, bukan ke belakang.
 */
@Controller('reports/uptime')
export class UptimeController {
  constructor(
    private uptime: UptimeQueryService,
    private pdf: UptimePdfService,
  ) {}

  /**
   * Unduh laporan uptime sebagai PDF.
   *
   * ⚠️ Rentang tanggal WAJIB sama persis dengan yang sedang dilihat kasir di
   * halaman. Kalau tidak, kasir mengunduh PDF 7 hari lalu sementara halaman
   * menampilkan 1 hari, dan keduanya sama-sama "benar" — itu sumber kebingungan
   * yang tidak ada gejalanya.
   *
   * ⚠️ Wajib JWT. PDF ini memuat daftar PC beserta nilai kWh dan biaya.
   */
  @Get('pdf')
  // ⚠️ `@Res()` harus DI AWAL. TypeScript menolak parameter wajib yang
  // mengikuti parameter opsional, dan itu error compile — bukan warning.
  async unduhPdf(
    @Res() res: Response,
    @Query('dari') dari?: string,
    @Query('sampai') sampai?: string,
  ) {
    const akhir = sampai ?? tanggalWib();
    const awal = dari ?? mundurHari(akhir, 6);
    let ringkasan;
    try {
      ringkasan = await this.uptime.ringkasan(awal, akhir);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const buffer = await this.pdf.build(ringkasan);
    const nama = `laporan-uptime-${awal}_${akhir}.pdf`;
    // ⚠️ Nama dibangun dari tanggal yang sudah lolos validasi `ringkasan()`,
    // bukan dari input mentah — input mentah bisa merusak header.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${nama}"`);
    res.end(buffer);
  }

  @Get()
  async ringkasan(@Query('dari') dari?: string, @Query('sampai') sampai?: string) {
    // Default: 7 hari terakhir sampai hari ini (WIB).
    const akhir = sampai ?? tanggalWib();
    const awal = dari ?? mundurHari(akhir, 6);
    try {
      return await this.uptime.ringkasan(awal, akhir);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}

function mundurHari(tanggal: string, jumlah: number): string {
  const d = new Date(`${tanggal}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - jumlah);
  return d.toISOString().slice(0, 10);
}
