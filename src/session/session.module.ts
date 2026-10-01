import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionGateway } from './session.gateway.js';
import { SessionService } from './session.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityLogModule } from '../activity-log/activity-log.module.js';
import { NotifikasiModule } from '../notifikasi/notifikasi.module.js';
import { LogBillingModule } from '../log-billing/log-billing.module.js';

@Module({
  imports: [
    PrismaModule,
    ActivityLogModule,
    NotifikasiModule,
    LogBillingModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
    }),
  ],
  providers: [SessionGateway, SessionService],
  exports: [SessionService, SessionGateway],
})
export class SessionModule {}
