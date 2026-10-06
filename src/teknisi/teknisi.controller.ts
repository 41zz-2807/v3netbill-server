import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator.js';
import { TeknisiService } from '../session/teknisi.service.js';
import { SessionGateway } from '../session/session.gateway.js';

class SimpanTeknisiDto {
  @IsString()
  @MinLength(1)
  username: string;

  /** Kosong = tidak mengubah PIN yang sudah ada. */
  @IsOptional()
  @IsString()
  password?: string;
}

class SetAktifDto {
  @IsBoolean()
  aktif: boolean;
}

/**
 * Pengelolaan akses teknisi.
 *
 * ⚠️ Semua endpoint di sini ADMIN. Endpoint publik untuk teknisi tidak ada
 * dan tidak boleh dibuat: verifikasi login teknisi terjadi di dalam
 * `handleLoginRequest()` pada gateway, yang tidak butuh JWT.
 */
@Controller('teknisi')
export class TeknisiController {
  constructor(
    private readonly teknisiService: TeknisiService,
    private readonly gateway: SessionGateway,
  ) {}

  /** Daftar akun teknisi + berapa sesi yang sedang berjalan. */
  @Get()
  @Roles(Role.ADMIN)
  async daftar() {
    return { akun: await this.teknisiService.daftarAkun() };
  }

  /** Buat akun baru, atau perbarui PIN kalau akunnya sudah ada. */
  @Post()
  @Roles(Role.ADMIN)
  async simpan(@Body() body: SimpanTeknisiDto) {
    const hasil = await this.teknisiService.simpanAkun(body.username, body.password);
    return { success: true, ...hasil };
  }

  /**
   * Nyalakan / matikan seluruh akses teknisi.
   *
   * ⚠️ Mematikan TIDAK hanya menolak login baru. Setiap PC yang sedang dipakai
   * teknisi harus dikunci SEKETIKA — kalau hanya menolak login berikutnya,
   * kebocoran PIN tidak akan menghentikan teknisi yang sedang di dalam.
   */
  @Patch('aktif')
  @Roles(Role.ADMIN)
  async setAktif(@Body() body: SetAktifDto) {
    const hasil = await this.teknisiService.setAktif(body.aktif);
    // ⚠️ Daftar PC-nya diambil `setAktif()` SEBELUM sesi ditutup. Kalau
    // gateway mencarinya sendiri setelah itu, yang ditemukan selalu nol.
    const terkunci = await this.gateway.kunciSemuaPcTeknisi(hasil.pcHarusDikunci);
    return { aktif: hasil.aktif, terkunci };
  }

  /**
   * Hapus akun teknisi.
   *
   * ⚠️ PC yang sedang dipakai teknisi itu **dikunci lebih dulu**, baru akunnya
   * dihapus. Urutan yang terbalik berarti teknisi masih bisa memakai PC
   * sampai logout manual, padahal akunnya sudah tidak ada lagi di server.
   */
  @Delete(':username')
  @Roles(Role.ADMIN)
  async hapus(@Param('username') username: string) {
    const pcIds = await this.teknisiService.hapusAkun(username);
    const terkunci = await this.gateway.kunciSebagianPcTeknisi(pcIds);
    return { terhapus: true, username, terkunci };
  }

  /** Health check ringan: berapa teknisi yang sedang di PC sekarang. */
  @Get('status')
  @Roles(Role.ADMIN)
  async status() {
    const sesi = await this.teknisiService.semuaSesiAktif();
    return { aktif: sesi.length, sesi };
  }
}
