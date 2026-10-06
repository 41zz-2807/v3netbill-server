import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module.js';
import { LaporanController } from './laporan.controller.js';
import { LaporanService } from './laporan.service.js';
import { ActivityLogModule } from '../activity-log/activity-log.module.js';
import { SettingsModule } from '../settings/settings.module.js';

@Module({
  // ⚠️ `SettingsModule` WAJIB di sini. `LaporanService` membaca daftar
  // penerima email dari tabel `Setting`, jadi tanpa import ini Nest gagal
  // resolve dependency dan APLIKASI TIDAK BISA START sama sekali — bukan
  // hanya laporannya yang gagal.
  //
  // `SettingsModule` mengekspor `SettingsService`, jadi tidak perlu
  // `forwardRef` meski `SettingsModule` sendiri mengimpor `SessionModule`.
  imports: [ReportsModule, ActivityLogModule, SettingsModule],
  controllers: [LaporanController],
  providers: [LaporanService],
})
export class LaporanModule {}
