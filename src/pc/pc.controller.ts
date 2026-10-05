import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { PcService } from './pc.service.js';
import { SessionService } from '../session/session.service.js';
import { CreatePcDto } from './dto/create-pc.dto.js';
import { GantiNamaPcDto } from './dto/ganti-nama-pc.dto.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
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

  @Get()
  async findAll() {
    return this.pcService.findAll();
  }

  /**
   * Ganti nama/label PC. ADMIN saja.
   *
   * `namaPc` bukan identitas, jadi ini aman dipakai saat PC sedang dipakai
   * pelanggan — sesi, agent, dan token tidak tersentuh. Lihat catatan panjang
   * di `PcService.gantiNama()`.
   */
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