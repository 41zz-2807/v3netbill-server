import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionGateway } from '../session/session.gateway.js';
import { CreateVoucherDto } from './dto/create-voucher.dto.js';
import { CreateMemberDto } from './dto/create-member.dto.js';
import { TopupDto } from './dto/topup.dto.js';
import { KoreksiDto } from './dto/koreksi.dto.js';
import { BatalTransaksiDto } from './dto/batal-transaksi.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { PASSWORD_DEFAULT } from './password.js';
import { AccountsQueryDto } from './dto/accounts-query.dto.js';
import * as bcrypt from 'bcrypt';
import { AccountType, AccountStatus, TransactionType } from '@prisma/client';

@Injectable()
export class AccountsService {
  constructor(
    private prisma: PrismaService,
    private sessionGateway: SessionGateway,
  ) {}

  private validateNominal(nominal: number): void {
    if (nominal % 500 !== 0) {
      throw new BadRequestException('Nominal harus kelipatan 500');
    }
  }

  private generateKodeUnik(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private async getHargaPerMenit(): Promise<number> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: 'harga_per_menit' },
    });
    return setting ? parseInt(setting.value, 10) : 150;
  }

  private async calculateSisaWaktu(nominal: number): Promise<number> {
    const hargaPerMenit = await this.getHargaPerMenit();
    const durasiMenit = nominal / hargaPerMenit;
    return Math.floor(durasiMenit * 60);
  }

  async createVoucher(createVoucherDto: CreateVoucherDto, kasirId: string) {
    this.validateNominal(createVoucherDto.nominal);

    const sisaWaktuDetik = await this.calculateSisaWaktu(createVoucherDto.nominal);
    // Semua akun baru mulai dari password yang sama, jadi kasir cukup mencatat
    // kode voucher saja.
    const password = PASSWORD_DEFAULT;
    const passwordHash = await bcrypt.hash(password, 10);

    let kodeUnik: string;
    let attempts = 0;
    const maxAttempts = 10;

    do {
      kodeUnik = this.generateKodeUnik();
      const existing = await this.prisma.account.findUnique({
        where: { kodeUnik },
      });
      if (!existing) break;
      attempts++;
      if (attempts >= maxAttempts) {
        throw new ConflictException('Gagal generate kode unik, coba lagi');
      }
    } while (true);

    const account = await this.prisma.account.create({
      data: {
        tipe: AccountType.VOUCHER,
        kodeUnik,
        passwordHash,
        sisaWaktuDetik,
        status: AccountStatus.ACTIVE,
      },
    });

    await this.prisma.transaction.create({
      data: {
        accountId: account.id,
        nominal: createVoucherDto.nominal,
        durasiMenit: Math.floor(sisaWaktuDetik / 60),
        durasiDetik: sisaWaktuDetik,
        jenis: TransactionType.BELI_BARU,
        kasirId,
      },
    });

    this.sessionGateway.broadcastActivityLog('transaction:created', {
      jenis: 'voucher',
      kodeUnik: account.kodeUnik,
      nominal: createVoucherDto.nominal,
      durasiMenit: Math.floor(sisaWaktuDetik / 60),
      kasirId,
    });

    return {
      ...account,
      password,
    };
  }

  async createMember(createMemberDto: CreateMemberDto, kasirId: string) {
    this.validateNominal(createMemberDto.nominal);

    const existingMember = await this.prisma.account.findFirst({
      where: {
        tipe: AccountType.MEMBER,
        nama: createMemberDto.nama,
        status: { not: AccountStatus.REVOKED },
      },
    });
    if (existingMember) {
      throw new ConflictException('Member dengan nama tersebut sudah ada');
    }

    const sisaWaktuDetik = await this.calculateSisaWaktu(createMemberDto.nominal);
    const passwordHash = await bcrypt.hash(PASSWORD_DEFAULT, 10);

    const account = await this.prisma.account.create({
      data: {
        tipe: AccountType.MEMBER,
        nama: createMemberDto.nama,
        passwordHash,
        sisaWaktuDetik,
        status: AccountStatus.ACTIVE,
      },
    });

    await this.prisma.transaction.create({
      data: {
        accountId: account.id,
        nominal: createMemberDto.nominal,
        durasiMenit: Math.floor(sisaWaktuDetik / 60),
        durasiDetik: sisaWaktuDetik,
        jenis: TransactionType.BELI_BARU,
        kasirId,
      },
    });

    this.sessionGateway.broadcastActivityLog('transaction:created', {
      jenis: 'member',
      nama: createMemberDto.nama,
      nominal: createMemberDto.nominal,
      durasiMenit: Math.floor(sisaWaktuDetik / 60),
      kasirId,
    });

    return account;
  }

  async topup(id: string, topupDto: TopupDto, kasirId: string) {
    this.validateNominal(topupDto.nominal);

    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    if (account.status === AccountStatus.REVOKED) {
      throw new BadRequestException('Voucher sudah direvoke (nonaktifkan) — tidak bisa di-topup');
    }
    if (account.status === AccountStatus.EXPIRED) {
      throw new BadRequestException('Voucher sudah expired — tidak bisa di-topup');
    }
    if (account.status !== AccountStatus.ACTIVE) {
      throw new BadRequestException('Account tidak aktif');
    }

    const additionalWaktu = await this.calculateSisaWaktu(topupDto.nominal);

    const updatedAccount = await this.prisma.account.update({
      where: { id },
      data: {
        sisaWaktuDetik: account.sisaWaktuDetik + additionalWaktu,
        lastUsedAt: new Date(),
      },
    });

    await this.prisma.transaction.create({
      data: {
        accountId: account.id,
        nominal: topupDto.nominal,
        durasiMenit: Math.floor(additionalWaktu / 60),
        durasiDetik: additionalWaktu,
        jenis: TransactionType.TOPUP,
        kasirId,
      },
    });

    this.sessionGateway.broadcastActivityLog('transaction:created', {
      jenis: 'topup',
      nama: account.nama ?? null,
      kodeUnik: account.kodeUnik ?? null,
      nominal: topupDto.nominal,
      durasiMenit: Math.floor(additionalWaktu / 60),
      kasirId,
    });

    return updatedAccount;
  }

  async koreksi(id: string, koreksiDto: KoreksiDto, kasirId: string) {
    this.validateNominal(koreksiDto.nominal);

    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    if (account.status !== AccountStatus.ACTIVE) {
      throw new BadRequestException('Account tidak aktif');
    }

    // Nominal yang ditarik = nominal negatif (akuntansi: mengurangi pendapatan).
    const penarikanDetik = await this.calculateSisaWaktu(koreksiDto.nominal);

    if (penarikanDetik > account.sisaWaktuDetik) {
      throw new BadRequestException('Sisa waktu tidak mencukupi untuk penarikan tersebut');
    }

    const updatedAccount = await this.prisma.account.update({
      where: { id },
      data: {
        sisaWaktuDetik: account.sisaWaktuDetik - penarikanDetik,
        lastUsedAt: new Date(),
      },
    });

    await this.prisma.transaction.create({
      data: {
        accountId: account.id,
        nominal: -koreksiDto.nominal,
        durasiMenit: -Math.floor(penarikanDetik / 60),
        durasiDetik: -penarikanDetik,
        jenis: TransactionType.KOREKSI,
        kasirId,
      },
    });

    this.sessionGateway.broadcastActivityLog('transaction:created', {
      jenis: 'koreksi',
      nama: account.nama ?? null,
      kodeUnik: account.kodeUnik ?? null,
      nominal: -koreksiDto.nominal,
      durasiMenit: -Math.floor(penarikanDetik / 60),
      kasirId,
    });

    return updatedAccount;
  }

  async batalTransaksi(id: string, batalTransaksiDto: BatalTransaksiDto, kasirId: string) {
    // Batalkan transaksi terakhir milik akun ini, dalam jendela 10 menit sejak dibuat.
    const VOID_WINDOW_MS = 10 * 60 * 1000;

    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    const transaksi = await this.prisma.transaction.findFirst({
      where: { id: batalTransaksiDto.transactionId, accountId: account.id },
    });
    if (!transaksi) {
      throw new NotFoundException('Transaksi tidak ditemukan pada akun ini');
    }

    // Hanya transaksi TERAKHIR (yang paling baru dibuat) yang bisa dibatalkan.
    const terakhir = await this.prisma.transaction.findFirst({
      where: { accountId: account.id, dibatalkan: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!terakhir || terakhir.id !== transaksi.id) {
      throw new BadRequestException('Hanya transaksi terakhir yang bisa dibatalkan');
    }

    const umur = Date.now() - new Date(transaksi.createdAt).getTime();
    if (umur > VOID_WINDOW_MS) {
      throw new BadRequestException('Lebih dari 10 menit — transaksi tidak bisa dibatalkan, gunakan Tarik');
    }

    // Efek balik: TOPUP/BELI_BARU menambah waktu → kurangi; KOREKSI menarik → kembalikan.
    // durasiDetik disimpan negatif untuk KOREKSI. Transaksi lama (pra-migrasi) memakai
    // durasiDetik=0 → hitung ulang dari nominal.
    let efekDetik = transaksi.durasiDetik;
    if (efekDetik === 0) {
      if (transaksi.jenis === TransactionType.KOREKSI) {
        efekDetik = -Math.abs(await this.calculateSisaWaktu(Math.abs(transaksi.nominal)));
      } else {
        efekDetik = Math.abs(await this.calculateSisaWaktu(Math.abs(transaksi.nominal)));
      }
    }

    if (efekDetik > 0) {
      if (efekDetik > account.sisaWaktuDetik) {
        throw new BadRequestException('Sisa waktu akun sudah terpakai — tidak bisa dibatalkan, gunakan Tarik');
      }
      await this.prisma.account.update({
        where: { id },
        data: { sisaWaktuDetik: account.sisaWaktuDetik - efekDetik },
      });
    } else {
      // KOREKSI: kembalikan waktu yang ditarik ke akun.
      await this.prisma.account.update({
        where: { id },
        data: { sisaWaktuDetik: account.sisaWaktuDetik - efekDetik }, // minus(negatif) = tambah
      });
    }

    await this.prisma.transaction.update({
      where: { id: transaksi.id },
      data: { dibatalkan: new Date(), dibatalkanOleh: kasirId },
    });

    this.sessionGateway.broadcastActivityLog('transaction:created', {
      jenis: 'batal',
      nama: account.nama ?? null,
      kodeUnik: account.kodeUnik ?? null,
      nominal: transaksi.nominal,
      kasirId,
    });

    return this.prisma.account.findUnique({ where: { id } });
  }

  async changePassword(id: string, changePasswordDto: ChangePasswordDto) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    const passwordHash = await bcrypt.hash(changePasswordDto.password, 10);

    return this.prisma.account.update({
      where: { id },
      data: { passwordHash },
    });
  }

  async revoke(id: string) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    return this.prisma.account.update({
      where: { id },
      data: { status: AccountStatus.REVOKED },
    });
  }

  async findAll(query: AccountsQueryDto) {
    const where: Record<string, unknown> = {};

    if (query.tipe) {
      where.tipe = query.tipe;
    }

    if (query.status) {
      where.status = query.status;
    }

    const accounts = await this.prisma.account.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    // Untuk riwayat per akun: tandai transaksi terakhir (belum dibatalkan) yang masih
    // dalam jendela 10 menit sebagai "bisaDibatalkan".
    const VOID_WINDOW_MS = 10 * 60 * 1000;
    for (const acc of accounts) {
      const belumDibatal = acc.transactions.find((t) => t.dibatalkan === null);
      if (belumDibatal) {
        const umur = Date.now() - new Date(belumDibatal.createdAt).getTime();
        (belumDibatal as Record<string, unknown>).bisaDibatalkan = umur <= VOID_WINDOW_MS;
      }
      for (const t of acc.transactions) {
        (t as Record<string, unknown>).bisaDibatalkan ??= false;
      }
    }

    return accounts;
  }
}