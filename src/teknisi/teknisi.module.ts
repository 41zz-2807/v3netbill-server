import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module.js';
import { TeknisiController } from './teknisi.controller.js';

/**
 * ⚠️ `SessionModule` meng-export `TeknisiService` DAN `SessionGateway`, jadi
 * module ini cukup mengimpor SATU modul. Mengimpor `PrismaModule` terpisah
 * tidak perlu — semua query sudah lewat `TeknisiService`.
 */
@Module({
  imports: [SessionModule],
  controllers: [TeknisiController],
})
export class TeknisiModule {}
