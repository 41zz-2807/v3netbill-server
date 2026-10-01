import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LogBillingController } from './log-billing.controller.js';
import { LogBillingCron } from './log-billing.cron.js';
import { LogBillingService } from './log-billing.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [LogBillingController],
  providers: [LogBillingService, LogBillingCron],
  // Diekspor supaya SessionGateway bisa menulis log tanpa mengulang modul.
  exports: [LogBillingService],
})
export class LogBillingModule {}
