import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreatePcDto } from './dto/create-pc.dto.js';
import { statusPcEfektif } from './pc-status.js';
import { randomUUID } from 'crypto';

@Injectable()
export class PcService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const pcs = await this.prisma.pc.findMany({
      orderBy: { namaPc: 'asc' },
    });
    // Kolom status di database tidak pernah diubah jadi OFFLINE, jadi status
    // yang dikembalikan harus dihitung ulang dari heartbeat terakhir. Tanpa ini
    // PC yang dimatikan akan terus terbaca IDLE.
    return pcs.map((pc) => ({
      ...pc,
      status: statusPcEfektif(pc.status, pc.lastHeartbeatAt),
    }));
  }

  async create(createPcDto: CreatePcDto) {
    const agentToken = randomUUID();
    return this.prisma.pc.create({
      data: {
        namaPc: createPcDto.namaPc,
        // Kolom NOT NULL tanpa default; string kosong berarti "belum pernah
        // teramati" dan akan terisi begitu agent connect.
        ipClient: createPcDto.ipClient ?? '',
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