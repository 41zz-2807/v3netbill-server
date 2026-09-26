import { Injectable, UnauthorizedException, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { Role } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: loginDto.username },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: user.id, username: user.username, role: user.role };
    const access_token = this.jwtService.sign(payload);

    return {
      access_token,
      role: user.role,
    };
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async createUser(createUserDto: CreateUserDto) {
    const username = createUserDto.username.trim();

    const existing = await this.prisma.user.findUnique({
      where: { username },
    });
    if (existing) {
      throw new ConflictException(`Username "${username}" sudah dipakai`);
    }

    return this.prisma.user.create({
      data: {
        username,
        passwordHash: await this.hashPassword(createUserDto.password),
        role: createUserDto.role,
      },
      select: { id: true, username: true, role: true, createdAt: true },
    });
  }

  /** Daftar user untuk panel pengaturan. passwordHash tidak pernah dikembalikan. */
  async listUsers() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, username: true, role: true, createdAt: true },
    });
  }

  async deleteUser(id: string, currentUserId: string) {
    if (id === currentUserId) {
      throw new BadRequestException('Tidak bisa menghapus akun Anda sendiri');
    }

    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundException('User tidak ditemukan');
    }

    // Kalau admin terakhir dihapus, tidak ada lagi yang bisa menambah user
    // sehingga akun jadi buntu permanen.
    if (target.role === Role.ADMIN) {
      const jumlahAdmin = await this.prisma.user.count({
        where: { role: Role.ADMIN },
      });
      if (jumlahAdmin <= 1) {
        throw new BadRequestException(
          'Tidak bisa menghapus admin terakhir — tidak akan ada yang bisa menambah user lagi',
        );
      }
    }

    // Transaction.kasirId mewajibkan user (delete rule RESTRICT), jadi user
    // yang sudah pernah dipakai bertransaksi tidak bisa dihapus.
    const jumlahTransaksi = await this.prisma.transaction.count({
      where: { kasirId: id },
    });
    if (jumlahTransaksi > 0) {
      throw new ConflictException(
        `User "${target.username}" punya ${jumlahTransaksi} transaksi — tidak bisa dihapus`,
      );
    }

    await this.prisma.user.delete({ where: { id } });
    return { deleted: target.username };
  }
}
