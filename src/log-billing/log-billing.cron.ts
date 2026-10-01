import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LogBillingService } from './log-billing.service.js';

/**
 * Menghapus berkas log yang lebih tua dari 30 hari.
 *
 * Dipisah dari [LogBillingService] supaya file itu tidak perlu tahu soal
 * jadwal, dan supaya jadwal bisa diubah tanpa menyentuh format log.
 */
@Injectable()
export class LogBillingCron implements OnModuleInit {
  private readonly logger = new Logger(LogBillingCron.name);

  constructor(private readonly log: LogBillingService) {}

  /**
   * Bersihkan sekali saat server start.
   *
   * Tanpa ini, kalau server mati berhari-hari, cron tidak pernah jalan dan
   * folder log tumbuh terus tanpa batas.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.log.hapusLama();
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Pembersihan log awal gagal: ${pesan}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'cleanup-log-billing' })
  async handleCleanupLogBilling(): Promise<void> {
    this.logger.log('Cron cleanup log billing dijalankan');
    try {
      const terhapus = await this.log.hapusLama();
      if (terhapus > 0) {
        this.logger.log(`Dihapus ${terhapus} berkas log billing yang lama`);
      }
    } catch (err) {
      this.logger.error(
        `Cleanup log billing gagal: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
