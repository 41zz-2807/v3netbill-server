import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { PcService } from './pc.service.js';
import { SessionService } from '../session/session.service.js';
import { CreatePcDto } from './dto/create-pc.dto.js';
import { GantiNamaPcDto } from './dto/ganti-nama-pc.dto.js';
import { SetWattPcDto } from './dto/set-watt-pc.dto.js';
import { SetRusakPcDto } from './dto/set-rusak-pc.dto.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Role } from '@prisma/client';

@Controller('pcs')
export class PcController {
  constructor(
    private readonly pcService: PcService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Ringkasan PC untuk halaman login, tanpa JWT.
   *
   * ⚠️ Endpoint ini publik, jadi isinya harus tetap minimal. Lihat catatan
   * panjang di `PcService.ringkas()` — terutama soal kenapa `findAll()` yang
   * memuat `agentToken` TIDAK BOLEH dijadikan publik.
   */
  @Get('ringkas')
  @Public()
  async ringkas() {
    return this.pcService.ringkas();
  }

  /**
   * Daftar PC.
   *
   * `?termasukRusak=true` menambah PC yang ditandai rusak, dan itu **hanya untuk
   * Halaman PC** — PC yang ditandai harus kelihatan di sana supaya flag-nya
   * bisa dibatalkan. Hanya ADMIN yang boleh memakai parameter itu, karena
   * hanya ADMIN yang boleh mengubah flag.
   *
   * ⚠️ Endpoint ini TIDAK BOLEH jadi `@Public()`. Nilai kembalannya
   * `{ ...pc }`, jadi `agentToken` ikut terbawa — dan token itu cukup untuk
   * mengganti password akun orang serta menghentikan sesi. Yang aman untuk
   * halaman login (tanpa JWT) adalah `GET /pcs/ringkas` di atas.
   */
  @Get()
  async findAll(
    @Query('termasukRusak') termasukRusak: string | undefined,
    @CurrentUser() user: { role: Role },
  ) {
    // Kasir tetap boleh membaca daftar PC biasa, jadi `@Roles(ADMIN)` tidak
    // bisa dipakai di sini — dia berlaku untuk seluruh request. Parameternya
    // yang dibatasi, bukan endpointnya.
    const mauTermasuk = termasukRusak === 'true' && user?.role === Role.ADMIN;
    return this.pcService.findAll(mauTermasuk);
  }

  /**
   * Nyalakan / matikan flag "PC rusak". ADMIN saja.
   *
   * PC yang ditandai tidak muncul di dashboard, halaman login, dan mobile;
   * sesi yang sedang berjalan langsung dihentikan; sesi baru ditolak.
   * Lihat catatan panjang di `PcService.setRusak()`.
   */
  @Patch(':id/rusak')
  @Roles(Role.ADMIN)
  async setRusak(@Param('id') id: string, @Body() dto: SetRusakPcDto) {
    return this.pcService.setRusak(id, dto);
  }

  /**
   * Ganti nama/label PC. ADMIN saja.
   *
   * `namaPc` bukan identitas, jadi ini aman dipakai saat PC sedang dipakai
   * pelanggan — sesi, agent, dan token tidak tersentuh. Lihat catatan panjang
   * di `PcService.gantiNama()`.
   */
  /**
   * Ubah daya listrik PC (watt), dipakai untuk estimasi biaya listrik di
   * laporan uptime.
   *
   * ⚠️ ADMIN saja — angka ini jadi_acuan biaya, jadi kasir tidak boleh
   * bebas mengubahnya tanpa sengaja.
   */
  @Patch(':id/watt')
  @Roles(Role.ADMIN)
  async setWatt(@Param('id') id: string, @Body() dto: SetWattPcDto) {
    return this.pcService.setWatt(id, dto.watt);
  }

  @Patch(':id/nama')
  @Roles(Role.ADMIN)
  async gantiNama(@Param('id') id: string, @Body() dto: GantiNamaPcDto) {
    return this.pcService.gantiNama(id, dto);
  }

  @Post()
  @Roles(Role.ADMIN)
  async create(@Body() createPcDto: CreatePcDto) {
    return this.pcService.create(createPcDto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  async remove(@Param('id') id: string) {
    return this.pcService.remove(id);
  }

  @Post(':id/unlock')
  @Roles(Role.ADMIN)
  async unlock(@Param('id') id: string) {
    return this.sessionService.unlockPc(id);
  }
}