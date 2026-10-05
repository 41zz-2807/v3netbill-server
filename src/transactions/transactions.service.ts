import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TransactionsQueryDto } from './dto/transactions-query.dto.js';
import { akhirHariWib, awalHariWib } from '../common/wib-date.js';

@Injectable()
export class TransactionsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: TransactionsQueryDto) {
    const where: Record<string, unknown> = {};

    if (query.accountId) {
      where.accountId = query.accountId;
    }

    if (query.dari || query.sampai) {
      where.createdAt = {};
      // ⚠️ Batas harus dihitung sebagai WIB, bukan `new Date(query.dari)` +
      // `setHours(23,59,59,999)`. Server berjalan di UTC, jadi cara itu
      // menghasilkan 00:00 UTC (07:00 WIB) sampai 23:59 UTC (06:59 WIB
      // berikutnya) — 7 jam meleset di kedua ujung.
      if (query.dari) {
        (where.createdAt as Record<string, Date>).gte = awalHariWib(query.dari);
      }
      if (query.sampai) {
        (where.createdAt as Record<string, Date>).lte = akhirHariWib(query.sampai);
      }
    }

    const hasil = await this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        account: {
          select: {
            id: true,
            kodeUnik: true,
            nama: true,
            tipe: true,
          },
        },
        kasir: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });

    // Tandai transaksi terakhir (belum dibatalkan) dalam jendela 10 menit = bisa dibatalkan.
    const VOID_WINDOW_MS = 10 * 60 * 1000;
    const lastByAccount = new Map<string, (typeof hasil)[number]>();
    for (const tx of hasil) {
      if (tx.dibatalkan === null && !lastByAccount.has(tx.accountId)) {
        lastByAccount.set(tx.accountId, tx);
      }
    }
    for (const tx of hasil) {
      const last = lastByAccount.get(tx.accountId);
      const bisa = tx.dibatalkan === null && last?.id === tx.id &&
        Date.now() - new Date(tx.createdAt).getTime() <= VOID_WINDOW_MS;
      (tx as Record<string, unknown>).bisaDibatalkan = bisa;
    }

    return hasil;
  }
}