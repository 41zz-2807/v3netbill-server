import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module.js';
import { LaporanController } from './laporan.controller.js';
import { LaporanService } from './laporan.service.js';

@Module({
  imports: [ReportsModule],
  controllers: [LaporanController],
  providers: [LaporanService],
})
export class LaporanModule {}