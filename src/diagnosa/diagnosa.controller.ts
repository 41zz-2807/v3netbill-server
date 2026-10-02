import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile as UploadedFileDecorator,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { DiagnosaService } from './diagnosa.service.js';
import type { UploadedFile } from './diagnosa.service.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '@prisma/client';

const zipFilter = (
  _req: Request,
  file: UploadedFile,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void => {
  const allowed = /\.zip$/i.test(file.originalname);
  cb(allowed ? null : new BadRequestException('Berkas harus .zip'), allowed);
};

@Controller('diagnosa')
export class DiagnosaController {
  constructor(private readonly diagnosaService: DiagnosaService) {}

  /**
   * Terima paket diagnosa dari agent Windows.
   *
   * `@Public()` karena agent tidak punya JWT; identitasnya `pcId` +
   * `agentToken`, persis seperti `POST /api/settings/verify-pin`.
   */
  @Public()
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: zipFilter }))
  async terima(
    @Body('pcId') pcId: string,
    @Body('agentToken') agentToken: string,
    @UploadedFileDecorator() file: UploadedFile,
  ) {
    if (!pcId || !agentToken) {
      throw new BadRequestException('pcId dan agentToken wajib diisi');
    }
    return this.diagnosaService.simpan(pcId, agentToken, file);
  }

  @Roles(Role.ADMIN)
  @Get()
  list() {
    return this.diagnosaService.list();
  }

  @Roles(Role.ADMIN)
  @Get(':nama')
  unduh(@Param('nama') nama: string, @Res() res: Response): void {
    const filePath = this.diagnosaService.filePath(nama);
    // Nama header dibangun dari `path.basename` yang sudah divalidasi service,
    // bukan dari input mentah — input mentah bisa merusak Content-Disposition.
    const namaAman = filePath.split(/[\\/]/).pop() ?? 'diagnosa.zip';
    res.download(filePath, namaAman);
  }
}