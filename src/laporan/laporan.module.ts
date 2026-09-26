import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module.js';
import { LaporanController } from './laporan.controller.js';
import { LaporanService } from './laporan.service.js';
import { ActivityLogModule } from '../activity-log/activity-log.module.js';

@Module({
  imports: [ReportsModule, ActivityLogModule],
  controllers: [LaporanController],
  providers: [LaporanService],
})
export class LaporanModule {}
