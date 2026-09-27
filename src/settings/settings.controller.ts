import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Query,
  UseInterceptors,
  UploadedFile as UploadedFileDecorator,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { SettingsService } from './settings.service.js';
import type { UploadedFile } from './settings.service.js';
import { PatchSettingDto } from './dto/patch-setting.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { PinUninstallDto } from './dto/pin-uninstall.dto.js';
import { VerifyPinDto } from './dto/verify-pin.dto.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Role } from '@prisma/client';

const installerFileFilter = (
  _req: Request,
  file: UploadedFile,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void => {
  const allowed = /\.(exe|msi)$/i.test(file.originalname);
  cb(allowed ? null : new BadRequestException('Installer harus .exe atau .msi'), allowed);
};

const apkFileFilter = (
  _req: Request,
  file: UploadedFile,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void => {
  const allowed = /\.apk$/i.test(file.originalname);
  cb(allowed ? null : new BadRequestException('File aplikasi harus .apk'), allowed);
};

const wallpaperFileFilter = (
  _req: Request,
  file: UploadedFile,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void => {
  const allowed = /\.(jpg|jpeg|png)$/i.test(file.originalname);
  cb(allowed ? null : new BadRequestException('Wallpaper harus .jpg/.jpeg/.png'), allowed);
};

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getAll() {
    return this.settingsService.getAll();
  }

  @Patch()
  @Roles(Role.ADMIN)
  async patch(@Body() body: PatchSettingDto) {
    return this.settingsService.patchValue(body.key, body.value);
  }

  @Patch('password')
  async changePassword(@Req() req: Request, @Body() body: ChangePasswordDto) {
    const userId = (req.user as { id: string }).id;
    return this.settingsService.changeOwnPassword(userId, body.oldPassword, body.newPassword);
  }

  @Post('installer')
  @Roles(Role.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: installerFileFilter,
      limits: { fileSize: 200 * 1024 * 1024 },
    }),
  )
  async uploadInstaller(@UploadedFileDecorator() file: UploadedFile) {
    if (!file) {
      throw new BadRequestException('File tidak ditemukan');
    }
    const meta = await this.settingsService.saveInstaller(file);
    return { success: true, meta };
  }

  @Get('installer')
  async getInstaller(@Res() res: Response) {
    const meta = await this.settingsService.getInstallerMeta();
    if (!meta) {
      throw new BadRequestException('Belum ada installer terupload');
    }
    const filePath = this.settingsService.getInstallerFilePath(meta);
    res.download(filePath, meta.filename);
    return;
  }

  @Post('apk')
  @Roles(Role.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: apkFileFilter,
      limits: { fileSize: 200 * 1024 * 1024 },
    }),
  )
  async uploadApk(@UploadedFileDecorator() file: UploadedFile) {
    if (!file) {
      throw new BadRequestException('File tidak ditemukan');
    }
    const meta = await this.settingsService.saveApk(file);
    return { success: true, meta };
  }

  @Get('apk')
  async getApk(@Res() res: Response) {
    const meta = await this.settingsService.getApkMeta();
    if (!meta) {
      throw new BadRequestException('Belum ada APK terupload');
    }
    const filePath = this.settingsService.getApkFilePath(meta);
    res.download(filePath, 'v3netbill.apk');
    return;
  }

  @Post('wallpaper')
  @Roles(Role.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: wallpaperFileFilter,
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async uploadWallpaper(@UploadedFileDecorator() file: UploadedFile) {
    if (!file) {
      throw new BadRequestException('File tidak ditemukan');
    }
    const result = await this.settingsService.saveWallpaper(file);
    return { success: true, ...result };
  }

  @Get('wallpaper')
  @Public()
  async getWallpaper(@Res() res: Response) {
    const info = await this.settingsService.getWallpaperFilePath();
    if (!info) {
      throw new BadRequestException('Belum ada wallpaper terupload');
    }
    res.sendFile(info.filePath, { root: '/' });
    return;
  }

  @Post('backup')
  @Roles(Role.ADMIN)
  async backup() {
    const result = await this.settingsService.createBackup();
    return { success: true, ...result };
  }

  @Get('backup/last')
  @Roles(Role.ADMIN)
  async lastBackup() {
    const last = await this.settingsService.getLastBackup();
    return { success: true, last };
  }

  @Get('backup/list')
  @Roles(Role.ADMIN)
  async backupList() {
    const daftar = await this.settingsService.listBackups();
    return { success: true, daftar };
  }

  @Get('backup/download')
  @Roles(Role.ADMIN)
  async downloadBackup(@Query('filename') filename: string, @Res() res: Response) {
    if (!filename) {
      throw new BadRequestException('filename wajib diisi');
    }
    const filePath = this.settingsService.getBackupFilePath(filename);
    res.download(filePath, filename);
    return;
  }

  @Patch('pin-uninstall')
  @Roles(Role.ADMIN)
  async setPinUninstall(@Body() body: PinUninstallDto) {
    return this.settingsService.setPinUninstall(body.pin);
  }

  @Public()
  @Post('verify-pin')
  async verifyPin(@Body() body: VerifyPinDto) {
    return this.settingsService.verifyPinUninstall(body.pcId, body.agentToken, body.pin);
  }
}