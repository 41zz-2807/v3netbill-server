import { Module } from '@nestjs/common';
import { DokumentasiController } from './dokumentasi.controller.js';
import { DokumentasiService } from './dokumentasi.service.js';

@Module({
  controllers: [DokumentasiController],
  providers: [DokumentasiService],
})
export class DokumentasiModule {}