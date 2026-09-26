import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ActivityLogItem {
  id: string;
  event: string;
  detail: string | null;
  pcId: string | null;
  accountId: string | null;
  kasirId: string | null;
  createdAt: Date;
}

export interface PaginatedLogs {
  data: ActivityLogItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class ActivityLogService {
  constructor(private prisma: PrismaService) {}

  private getTutupHariBoundary(date = new Date()): Date {
    // 23:30 WIB = 16:30 UTC
    const boundary = new Date(date);
    boundary.setUTCHours(16, 30, 0, 0);
    if (date < boundary) {
      boundary.setUTCDate(boundary.getUTCDate() - 1);
    }
    return boundary;
  }

  private getDayBoundary(date = new Date()): { start: Date; end: Date } {
    const boundary = this.getTutupHariBoundary(date);
    const start = new Date(boundary);
    const end = new Date(boundary);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
  }

  async create(data: {
    event: string;
    detail?: string | null;
    pcId?: string | null;
    accountId?: string | null;
    kasirId?: string | null;
  }): Promise<ActivityLogItem> {
    return this.prisma.activityLog.create({
      data: {
        event: data.event,
        detail: data.detail ?? null,
        pcId: data.pcId ?? null,
        accountId: data.accountId ?? null,
        kasirId: data.kasirId ?? null,
      },
    });
  }

  async findByDay(
    date: Date,
    page = 1,
    limit = 30,
  ): Promise<PaginatedLogs> {
    const { start, end } = this.getDayBoundary(date);

    const [data, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where: {
          createdAt: {
            gte: start,
            lt: end,
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.activityLog.count({
        where: {
          createdAt: {
            gte: start,
            lt: end,
          },
        },
      }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findRecent(limit = 100): Promise<ActivityLogItem[]> {
    return this.prisma.activityLog.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByDateRange(
    dari: Date,
    sampai: Date,
    limit = 500,
  ): Promise<ActivityLogItem[]> {
    return this.prisma.activityLog.findMany({
      where: {
        createdAt: {
          gte: dari,
          lte: sampai,
        },
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteOldLogs(retentionDays = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);

    const result = await this.prisma.activityLog.deleteMany({
      where: {
        createdAt: {
          lt: cutoff,
        },
      },
    });

    return result.count;
  }

  async resetDayLogs(): Promise<number> {
    const { start } = this.getDayBoundary(new Date());

    const result = await this.prisma.activityLog.deleteMany({
      where: {
        createdAt: {
          lt: start,
        },
      },
    });

    return result.count;
  }
}
