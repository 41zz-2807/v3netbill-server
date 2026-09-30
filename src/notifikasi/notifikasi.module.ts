import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FcmService } from './fcm.service.js';
import { NotifikasiController } from './notifikasi.controller.js';
import { NotifikasiService } from './notifikasi.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [NotifikasiController],
  providers: [NotifikasiService, FcmService],
  exports: [NotifikasiService, FcmService],
})
export class NotifikasiModule {}
