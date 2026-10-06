import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { UptimeQueryService } from './uptime-query.service.js';
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
  constructor(private uptime: UptimeQueryService) {}

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
