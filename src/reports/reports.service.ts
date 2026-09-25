import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReportsQueryDto } from './dto/reports-query.dto.js';

export interface DailyReportAggregate {
  tanggal: string;
  totalLogin: number;
  voucherTerbentuk: number;
  voucherTopup: number;
  memberTerbentuk: number;
  memberTopup: number;
  pendapatanVoucher: number;
  pendapatanMember: number;
}

export interface TransaksiLaporan {
  id: string;
  waktu: Date;
  akun: string;
  tipe: 'VOUCHER' | 'MEMBER';
  jenis: string;
  nominal: number;
  kasir: string;
}

const WIB_OFFSET_MIN = 7 * 60;
const CUTOFF_WIB_MIN = 23 * 60 + 30;
const SHIFT_MS = (CUTOFF_WIB_MIN - WIB_OFFSET_MIN) * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  private parseTanggal(value: string): Date {
    const parts = value.split('-').map(Number);
    if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
      throw new BadRequestException('Format tanggal harus YYYY-MM-DD');
    }
    const [tahun, bulan, hari] = parts;
    if (bulan < 1 || bulan > 12 || hari < 1 || hari > 31) {
      throw new BadRequestException('Tanggal tidak valid');
    }
    return new Date(Date.UTC(tahun, bulan - 1, hari));
  }

  private formatTanggal(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private hariIniBaseUtc(): Date {
    const now = new Date();
    const shifted = new Date(now.getTime() + (WIB_OFFSET_MIN + 30) * 60 * 1000);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  }

  private windowBounds(base: Date): { start: Date; end: Date } {
    const end = new Date(base.getTime() + SHIFT_MS);
    const start = new Date(end.getTime() - DAY_MS);
    return { start, end };
  }

  private buildRange(query: ReportsQueryDto): { from: Date; to: Date; daftar: string[] } {
    let from: Date;
    let to: Date;

    if (query.dari && query.sampai) {
      from = this.parseTanggal(query.dari);
      to = this.parseTanggal(query.sampai);
    } else if (query.dari) {
      from = this.parseTanggal(query.dari);
      to = from;
    } else if (query.sampai) {
      to = this.parseTanggal(query.sampai);
      from = to;
    } else {
      from = this.hariIniBaseUtc();
      to = from;
    }

    if (to < from) {
      throw new BadRequestException('Tanggal sampai harus >= tanggal dari');
    }

    const maxHari = 366;
    const jumlahHari = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    if (jumlahHari > maxHari) {
      throw new BadRequestException(`Rentang tanggal maksimal ${maxHari} hari`);
    }

    const daftar: string[] = [];
    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
      daftar.push(this.formatTanggal(d));
    }

    return { from, to, daftar };
  }

  private async computeDaily(tanggal: string): Promise<DailyReportAggregate> {
    const { start, end } = this.windowBounds(this.parseTanggal(tanggal));

    const hasil: DailyReportAggregate = {
      tanggal,
      totalLogin: 0,
      voucherTerbentuk: 0,
      voucherTopup: 0,
      memberTerbentuk: 0,
      memberTopup: 0,
      pendapatanVoucher: 0,
      pendapatanMember: 0,
    };

    const [transaksi, sesiLogin] = await Promise.all([
      this.prisma.transaction.findMany({
        where: {
          createdAt: { gte: start, lt: end },
          dibatalkan: null,
        },
        include: { account: { select: { tipe: true } } },
      }),
      this.prisma.session.count({
        where: {
          waktuMulai: { gte: start, lt: end },
        },
      }),
    ]);

    hasil.totalLogin = sesiLogin;

    for (const tx of transaksi) {
      const isVoucher = tx.account.tipe === 'VOUCHER';
      const isTopup = tx.jenis === 'TOPUP';
      const isKoreksi = tx.jenis === 'KOREKSI';

      if (isKoreksi) {
        // Koreksi/penarikan: nominal negatif, kurangi pendapatan, tanpa menambah jumlah terbentuk/topup.
        if (isVoucher) {
          hasil.pendapatanVoucher += tx.nominal;
        } else {
          hasil.pendapatanMember += tx.nominal;
        }
        continue;
      }

      if (isVoucher) {
        if (isTopup) {
          hasil.voucherTopup += 1;
        } else {
          hasil.voucherTerbentuk += 1;
        }
        hasil.pendapatanVoucher += tx.nominal;
      } else {
        if (isTopup) {
          hasil.memberTopup += 1;
        } else {
          hasil.memberTerbentuk += 1;
        }
        hasil.pendapatanMember += tx.nominal;
      }
    }

    return hasil;
  }

  private async persistDaily(aggregate: DailyReportAggregate): Promise<void> {
    const tanggal = this.parseTanggal(aggregate.tanggal);
    await this.prisma.dailyReport.upsert({
      where: { tanggal },
      update: {
        totalLogin: aggregate.totalLogin,
        voucherTerbentuk: aggregate.voucherTerbentuk,
        voucherTopup: aggregate.voucherTopup,
        memberTerbentuk: aggregate.memberTerbentuk,
        memberTopup: aggregate.memberTopup,
        pendapatanVoucher: aggregate.pendapatanVoucher,
        pendapatanMember: aggregate.pendapatanMember,
      },
      create: {
        tanggal,
        totalLogin: aggregate.totalLogin,
        voucherTerbentuk: aggregate.voucherTerbentuk,
        voucherTopup: aggregate.voucherTopup,
        memberTerbentuk: aggregate.memberTerbentuk,
        memberTopup: aggregate.memberTopup,
        pendapatanVoucher: aggregate.pendapatanVoucher,
        pendapatanMember: aggregate.pendapatanMember,
      },
    });
  }

  async laporanTutupHari(): Promise<{
    tanggal: string;
    aggregate: DailyReportAggregate;
    transaksi: TransaksiLaporan[];
  }> {
    const tanggalIni = this.formatTanggal(this.hariIniBaseUtc());
    const tanggalTutup = this.formatTanggal(new Date(this.parseTanggal(tanggalIni).getTime() - DAY_MS));
    const { start, end } = this.windowBounds(this.parseTanggal(tanggalTutup));

    const [aggregate, rows] = await Promise.all([
      this.computeDaily(tanggalTutup),
      this.prisma.transaction.findMany({
        where: {
          createdAt: { gte: start, lt: end },
          dibatalkan: null,
        },
        include: {
          account: { select: { tipe: true, kodeUnik: true, nama: true } },
          kasir: { select: { username: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const transaksi: TransaksiLaporan[] = rows.map((r) => ({
      id: r.id,
      waktu: r.createdAt,
      akun: r.account.nama ?? r.account.kodeUnik ?? '-',
      tipe: r.account.tipe,
      jenis: r.jenis,
      nominal: r.nominal,
      kasir: r.kasir.username,
    }));

    return { tanggal: tanggalTutup, aggregate, transaksi };
  }

  async getToday(): Promise<DailyReportAggregate> {
    const aggregate = await this.computeDaily(this.formatTanggal(this.hariIniBaseUtc()));
    await this.persistDaily(aggregate);
    return aggregate;
  }

  async getDaily(query: ReportsQueryDto): Promise<DailyReportAggregate[]> {
    const { daftar } = this.buildRange(query);
    const hasil: DailyReportAggregate[] = [];
    for (const tanggal of daftar) {
      const aggregate = await this.computeDaily(tanggal);
      await this.persistDaily(aggregate);
      hasil.push(aggregate);
    }
    return hasil;
  }

  async getRange(query: ReportsQueryDto): Promise<{
    dari: string;
    sampai: string;
    totalLogin: number;
    voucherTerbentuk: number;
    voucherTopup: number;
    memberTerbentuk: number;
    memberTopup: number;
    pendapatanVoucher: number;
    pendapatanMember: number;
    totalPendapatan: number;
    daftar: DailyReportAggregate[];
  }> {
    const { daftar, from, to } = this.buildRange(query);
    const list = await this.getDaily({ dari: daftar[0], sampai: daftar[daftar.length - 1] });

    return {
      dari: this.formatTanggal(from),
      sampai: this.formatTanggal(to),
      totalLogin: list.reduce((s, x) => s + x.totalLogin, 0),
      voucherTerbentuk: list.reduce((s, x) => s + x.voucherTerbentuk, 0),
      voucherTopup: list.reduce((s, x) => s + x.voucherTopup, 0),
      memberTerbentuk: list.reduce((s, x) => s + x.memberTerbentuk, 0),
      memberTopup: list.reduce((s, x) => s + x.memberTopup, 0),
      pendapatanVoucher: list.reduce((s, x) => s + x.pendapatanVoucher, 0),
      pendapatanMember: list.reduce((s, x) => s + x.pendapatanMember, 0),
      totalPendapatan: list.reduce((s, x) => s + x.pendapatanVoucher, 0) + list.reduce((s, x) => s + x.pendapatanMember, 0),
      daftar: list,
    };
  }
}