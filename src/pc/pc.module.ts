import { Module } from '@nestjs/common';
import { PcController } from './pc.controller.js';
import { PcService } from './pc.service.js';
import { SessionModule } from '../session/session.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule, SessionModule],
  controllers: [PcController],
  providers: [PcService],
  exports: [PcService],
})
export class PcModule {}