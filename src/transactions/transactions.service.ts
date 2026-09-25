import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TransactionsQueryDto } from './dto/transactions-query.dto.js';

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
      if (query.dari) {
        (where.createdAt as Record<string, Date>).gte = new Date(query.dari);
      }
      if (query.sampai) {
        const sampaiDate = new Date(query.sampai);
        sampaiDate.setHours(23, 59, 59, 999);
        (where.createdAt as Record<string, Date>).lte = sampaiDate;
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