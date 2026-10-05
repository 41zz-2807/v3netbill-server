import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { SessionStatus, AccountType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreatePcDto } from './dto/create-pc.dto.js';
import { GantiNamaPcDto } from './dto/ganti-nama-pc.dto.js';
import { statusPcDitampilkan } from './pc-status.js';
import { LogBillingService } from '../log-billing/log-billing.service.js';
import { SessionService } from '../session/session.service.js';
import { randomUUID } from 'crypto';

export interface StatusPcRingkas {
  namaPc: string;
  status: 'ACTIVE' | 'IDLE' | 'OFFLINE';
  tipe: AccountType | null;
  sisaDetik: number | null;
}

@Injectable()
export class PcService {
  constructor(
    private prisma: PrismaService,
    private logBilling: LogBillingService,
    private sessionService: SessionService,
  ) {}

  /**
   * Ganti label nama PC.
   *
   * Aman terhadap sesi yang sedang berjalan: `namaPc` bukan identitas, jadi
   * sesi, agent, dan `agentToken` tidak tersentuh. Yang sengaja diproses:
   *
   * 1. **Duplikat ditolak.** Kolom `namaPc` tidak punya index unik, jadi
   *    tanpa aturan ini dua PC bisa sama-sama bernama "PC001". Itu langsung
   *    membingungkan di daftar PC, dan membuat `key={namaPc}` pada halaman
   *    login bentrok (React memakai `key` untuk mengidentifikasi baris).
   * 2. **Cache log billing dibuang.** `namaPcUntuk()` hanya mengisi cache
   *    saat masih kosong — tanpa ini semua baris log berikutnya masih
   *    memakai nama LAMA.
   * 3. **Agent diberi tahu.** Nama PC adalah awalan nama berkas log Nextcloud,
   *    jadi tanpa dorongan ulang log repair tersimpan dengan nama lama.
   *
   * Ketiganya dibungkus try/catch terpisah: pengubahan nama tidak boleh gagal
   * hanya karena salah satu #'ya tidak berhasil.
   */
  async gantiNama(id: string, dto: GantiNamaPcDto): Promise<{ id: string; namaPc: string }> {
    const namaPc = dto.namaPc.trim();
    // ⚠️ Validasi diulang SETELAH trim. `@IsNotEmpty()` hanya menolak string
    // kosong, jadi input spasi saja (`"   "`) lolos DTO lalu `.trim()`
    // menjadikannya `""` — yang akan tersimpan sebagai nama PC kosong.
    if (namaPc.length === 0) {
      throw new BadRequestException('Nama PC tidak boleh kosong');
    }
    const pc = await this.prisma.pc.findUnique({
      where: { id },
      select: { id: true, namaPc: true },
    });
    if (!pc) {
      throw new NotFoundException('PC not found');
    }
    if (namaPc === pc.namaPc) {
      return { id, namaPc };
    }

    const bentrok = await this.prisma.pc.findFirst({
      where: { namaPc, NOT: { id } },
      select: { id: true },
    });
    if (bentrok) {
      throw new ConflictException(`Nama PC "${namaPc}" sudah dipakai PC lain`);
    }

    const hasil = await this.prisma.pc.update({
      where: { id },
      data: { namaPc },
      select: { id: true, namaPc: true },
    });

    try {
      this.logBilling.invalidateNamaPc();
    } catch {
      // Cache log billing adalah hal yang paling mudah hilang dan paling
      // mengganggu, tapi tidak boleh membatalkan pengubahan nama.
    }
    await this.sessionService.kirimUlangNamaKeAgent(id);

    return hasil;
  }

  async findAll() {
    const [pcs, sesiBerjalan] = await Promise.all([
      this.prisma.pc.findMany({
        orderBy: { namaPc: 'asc' },
      }),
      // Sesi ikut diambil karena kalau ada sesi berjalan dan heartbeat-nya
      // segar, status yang benar ACTIVE — bukan nilai kolom `status`, yang bisa
      // tertinggal OFFLINE dari `checkPcOffline()`.
      this.prisma.session.findMany({
        where: { status: SessionStatus.BERJALAN },
        select: { pcId: true },
      }),
    ]);
    const pcAdaSesi = new Set(sesiBerjalan.map((s) => s.pcId));
    return pcs.map((pc) => ({
      ...pc,
      status: statusPcDitampilkan(pc.status, pc.lastHeartbeatAt, pcAdaSesi.has(pc.id)),
    }));
  }

  /**
   * Ringkasan PC untuk halaman login. TANPA JWT (`@Public()`).
   *
   * ⚠️ ⚠️ JANGAN PERNAH membuat `findAll()` jadi publik. Method itu
   * mengembalikan `{ ...pc }` sehingga **`agentToken` ikut terbawa**, dan
   * token itu cukup untuk menjalankan `client:create_password` (mengganti
   * password akun orang) serta `client:stop_session` (menghentikan sesi).
   * Membukanya tanpa login berarti siapa pun di internet bisa mengambil
   * token itu. Endpoint ini sengaja dibuat terpisah dan hanya mengembalikan
   * empat field yang aman.
   *
   * Yang TIDAK ikut dikirim dan tidak boleh ditambah: `agentToken`, `id`,
   * `ipClient`, `lastHeartbeatAt`, dan identitas akun (nama member maupun
   * kode voucher). Nama member adalah kredensial login-nya, dan halaman login
   * terlihat siapa pun sebelum operator masuk.
   *
   * Sisa waktu dihitung dengan cara yang sama persis dengan
   * `getDashboardData()` supaya angkanya tidak mungkin berbeda dengan kartu PC
   * di dashboard.
   */
  async ringkas(): Promise<StatusPcRingkas[]> {
    const [pcs, sesiBerjalan] = await Promise.all([
      this.prisma.pc.findMany({ orderBy: { namaPc: 'asc' } }),
      this.prisma.session.findMany({
        where: { status: SessionStatus.BERJALAN },
        select: {
          pcId: true,
          waktuMulai: true,
          account: { select: { tipe: true, sisaWaktuDetik: true } },
        },
      }),
    ]);

    const bySesi = new Map(sesiBerjalan.map((s) => [s.pcId, s]));

    return pcs.map((pc) => {
      const sesi = bySesi.get(pc.id);
      const status = statusPcDitampilkan(pc.status, pc.lastHeartbeatAt, !!sesi);
      if (!sesi) {
        return { namaPc: pc.namaPc, status, tipe: null, sisaDetik: null };
      }
      const terpakai = Math.max(
        0,
        Math.floor((Date.now() - sesi.waktuMulai.getTime()) / 1000),
      );
      return {
        namaPc: pc.namaPc,
        status,
        tipe: sesi.account.tipe,
        sisaDetik: Math.max(0, sesi.account.sisaWaktuDetik - terpakai),
      };
    });
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