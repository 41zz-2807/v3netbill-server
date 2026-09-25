import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreatePcDto } from './dto/create-pc.dto.js';
import { randomUUID } from 'crypto';

@Injectable()
export class PcService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.pc.findMany({
      orderBy: { namaPc: 'asc' },
    });
  }

  async create(createPcDto: CreatePcDto) {
    const agentToken = randomUUID();
    return this.prisma.pc.create({
      data: {
        ...createPcDto,
        agentToken,
      },
    });
  }

  async remove(id: string) {
    const pc = await this.prisma.pc.findUnique({
      where: { id },
      include: { sessions: { select: { status: true } } },
    });
    if (!pc) {
      throw new NotFoundException('PC not found');
    }
    if (pc.sessions.some((s) => s.status === SessionStatus.BERJALAN)) {
      throw new BadRequestException('PC masih dalam sesi aktif, stop billing terlebih dahulu');
    }
    return this.prisma.$transaction([
      this.prisma.session.deleteMany({ where: { pcId: id } }),
      this.prisma.pc.delete({ where: { id } }),
    ]);
  }
}