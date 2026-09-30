import { Body, Controller, Delete, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { DaftarTokenDto } from './dto/daftar-token.dto.js';
import { NotifikasiService } from './notifikasi.service.js';

interface UserJwt {
  id: string;
  username: string;
  role: Role;
}

/**
 * Token perangkat untuk notifikasi push.
 *
 * Role tidak pernah diambil dari body: userId dan role selalu berasal dari
 * JWT hasil login. Endpoint ini terbuka untuk KASIR juga, karena aplikasi
 * menulis token-nya untuk semua user; yang menentukan siapa yang *menerima*
 * notifikasi adalah query di sisi server saat mengirim, bukan pendaftaran.
 */
@Controller('notifikasi')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.KASIR)
export class NotifikasiController {
  constructor(private readonly service: NotifikasiService) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async daftar(
    @CurrentUser() user: UserJwt,
    @Body() dto: DaftarTokenDto,
  ): Promise<{ success: boolean }> {
    const ok = await this.service.daftarToken(user.id, dto.token);
    return { success: ok };
  }

  @Delete('token')
  @HttpCode(HttpStatus.OK)
  async hapus(
    @CurrentUser() user: UserJwt,
    @Body() dto: DaftarTokenDto,
  ): Promise<{ success: boolean }> {
    await this.service.hapusToken(user.id, dto.token);
    return { success: true };
  }
}
