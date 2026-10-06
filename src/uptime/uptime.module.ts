import { Module } from '@nestjs/common';
import { UptimeService } from './uptime.service.js';
import { UptimeQueryService } from './uptime-query.service.js';
import { UptimeController } from './uptime.controller.js';
import { UptimePdfService } from './uptime-pdf.service.js';

@Module({
  controllers: [UptimeController],
  providers: [UptimeService, UptimeQueryService, UptimePdfService],
})
export class UptimeModule {}
