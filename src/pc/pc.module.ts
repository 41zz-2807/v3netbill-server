import { Module } from '@nestjs/common';
import { PcController } from './pc.controller.js';
import { PcService } from './pc.service.js';
import { SessionModule } from '../session/session.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LogBillingModule } from '../log-billing/log-billing.module.js';

@Module({
  // `LogBillingModule` dipakai untuk membuang cache nama PC saat nama diganti.
  // Tanpa itu, baris log billing tetap memakai nama LAMA selamanya karena
  // `namaPcUntuk()` hanya mengisi cache saat cache masih kosong.
  imports: [PrismaModule, SessionModule, LogBillingModule],
  controllers: [PcController],
  providers: [PcService],
  exports: [PcService],
})
export class PcModule {}