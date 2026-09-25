import { Post, Controller } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '@prisma/client';
import { LaporanService } from './laporan.service.js';

@Controller('laporan')
export class LaporanController {
  constructor(private readonly laporanService: LaporanService) {}

  @Post('kirim-tutup-hari')
  @Roles(Role.ADMIN)
  async kirimTutupHari() {
    return this.laporanService.kirimLaporanTutupHari();
  }
}