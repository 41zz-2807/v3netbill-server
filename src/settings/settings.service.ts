import { Injectable, Logger, BadRequestException, NotFoundException, UnauthorizedException, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityLogService } from '../activity-log/activity-log.service.js';

const execFileAsync = promisify(execFile);

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const DATA_DIR = '/data';
const INSTALLER_DIR = path.join(DATA_DIR, 'installer');
const WALLPAPER_DIR = path.join(DATA_DIR, 'wallpaper');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');

const MAX_INSTALLER_SIZE = 200 * 1024 * 1024;
const MAX_WALLPAPER_SIZE = 10 * 1024 * 1024;
const BACKUP_RETENTION_DAYS = 30;
const ACTIVITY_LOG_RETENTION_DAYS = 30;

export interface InstallerMeta {
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
}

@Injectable()
export class SettingsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private prisma: PrismaService,
    private schedulerRegistry: SchedulerRegistry,
    private activityLogService: ActivityLogService,
  ) {
    for (const dir of [INSTALLER_DIR, WALLPAPER_DIR, BACKUP_DIR]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  onApplicationBootstrap(): void {
    try {
      const jobs = this.schedulerRegistry.getCronJobs();
      for (const [name, job] of jobs.entries()) {
        this.logger.log(`Scheduler terdaftar: cron "${name}" — next ${job.nextDate().toString()}`);
      }
    } catch (err) {
      this.logger.warn(`Tidak ada cron job terdaftar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async get(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  async getAll(): Promise<Record<string, string>> {
    const rows = await this.prisma.setting.findMany();
    return rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
  }

  async patchValue(key: string, value: string): Promise<{ key: string; value: string }> {
    await this.set(key, value);
    return { key, value };
  }

  async changeOwnPassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User tidak ditemukan');
    }

    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) {
      throw new BadRequestException('Password lama salah');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    return { success: true };
  }

  async saveInstaller(file: UploadedFile): Promise<InstallerMeta> {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.exe', '.msi'].includes(ext)) {
      throw new BadRequestException('Installer harus berformat .exe atau .msi');
    }
    if (file.size > MAX_INSTALLER_SIZE) {
      throw new BadRequestException('Ukuran installer maksimal 200MB');
    }

    const filename = `installer-${Date.now()}${ext}`;
    const filePath = path.join(INSTALLER_DIR, filename);
    fs.writeFileSync(filePath, file.buffer);

    const meta: InstallerMeta = {
      filename,
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
    };
    await this.set('installer_meta', JSON.stringify(meta));
    return meta;
  }

  async getInstallerMeta(): Promise<InstallerMeta | null> {
    const raw = await this.get('installer_meta');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InstallerMeta;
    } catch {
      return null;
    }
  }

  getInstallerFilePath(meta: InstallerMeta): string {
    const filePath = path.join(INSTALLER_DIR, meta.filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('File installer tidak ditemukan');
    }
    return filePath;
  }

  async saveWallpaper(file: UploadedFile): Promise<{ path: string }> {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      throw new BadRequestException('Wallpaper harus berformat .jpg/.jpeg/.png');
    }
    if (file.size > MAX_WALLPAPER_SIZE) {
      throw new BadRequestException('Ukuran wallpaper maksimal 10MB');
    }

    const filename = `wallpaper-${Date.now()}${ext}`;
    const filePath = path.join(WALLPAPER_DIR, filename);
    fs.writeFileSync(filePath, file.buffer);

    await this.set('wallpaper_lockscreen_path', `wallpaper/${filename}`);
    return { path: `wallpaper/${filename}` };
  }

  async getWallpaperFilePath(): Promise<{ filePath: string; filename: string } | null> {
    const raw = await this.get('wallpaper_lockscreen_path');
    if (!raw) return null;
    const filename = raw.split('/').pop() as string;
    const filePath = path.join(WALLPAPER_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return { filePath, filename };
  }

  async createBackup(): Promise<{ filename: string; sizeBytes: number }> {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new BadRequestException('DATABASE_URL tidak tersedia');
    }
    const pgUrl = url.split('?')[0];
    const dbUrl = url.split('?')[0];
    const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    const filePath = path.join(BACKUP_DIR, filename);

    try {
      await execFileAsync('pg_dump', ['--no-owner', '--clean', dbUrl, '--file', filePath]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Backup gagal: ${msg}`);
      throw new BadRequestException('Backup database gagal');
    }

    const sizeBytes = fs.statSync(filePath).size;
    await this.set(
      'backup_last',
      JSON.stringify({ filename, sizeBytes, createdAt: new Date().toISOString() }),
    );
    this.logger.log(`Backup selesai: ${filename} (${sizeBytes} bytes)`);
    return { filename, sizeBytes };
  }

  async getLastBackup(): Promise<{ filename: string; sizeBytes: number; createdAt: string } | null> {
    const raw = await this.get('backup_last');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async listBackups(): Promise<{ filename: string; sizeBytes: number; createdAt: string }[]> {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getBackupFilePath(filename: string): string {
    const safe = path.basename(filename);
    const filePath = path.join(BACKUP_DIR, safe);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new NotFoundException('Backup tidak ditemukan');
    }
    return filePath;
  }

  async setPinUninstall(pin: string): Promise<{ success: boolean }> {
    const hash = await bcrypt.hash(pin, 10);
    await this.set('pin_uninstall_hash', hash);
    return { success: true };
  }

  async verifyPinUninstall(
    pcId: string,
    agentToken: string,
    pin: string,
  ): Promise<{ valid: boolean; configured: boolean }> {
    const pc = await this.prisma.pc.findUnique({ where: { id: pcId } });
    if (!pc || pc.agentToken !== agentToken) {
      throw new UnauthorizedException('agentToken PC tidak valid');
    }
    const hash = await this.get('pin_uninstall_hash');
    if (!hash) {
      return { valid: false, configured: false };
    }
    const valid = await bcrypt.compare(pin, hash);
    return { valid, configured: true };
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'auto-backup' })
  async handleAutoBackup(): Promise<void> {
    this.logger.log('Cron auto-backup dijalankan');
    try {
      await this.createBackup();
      await this.cleanupOldBackups();
    } catch (err) {
      this.logger.error(`Auto-backup gagal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'cleanup-activity-logs' })
  async handleCleanupActivityLogs(): Promise<void> {
    this.logger.log('Cron cleanup activity logs dijalankan');
    try {
      const removed = await this.activityLogService.deleteOldLogs(ACTIVITY_LOG_RETENTION_DAYS);
      if (removed > 0) {
        this.logger.log(`Dihapus ${removed} activity log lama (lebih dari ${ACTIVITY_LOG_RETENTION_DAYS} hari)`);
      }
    } catch (err) {
      this.logger.error(`Cleanup activity logs gagal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async cleanupOldBackups(): Promise<number> {
    const threshold = Date.now() - BACKUP_RETENTION_DAYS * 24 * 3600 * 1000;
    let removed = 0;
    const files = fs.readdirSync(BACKUP_DIR);
    for (const file of files) {
      const filePath = path.join(BACKUP_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.mtimeMs < threshold) {
        fs.rmSync(filePath);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.log(`Dihapus ${removed} backup lama (lebih dari ${BACKUP_RETENTION_DAYS} hari)`);
    }
    return removed;
  }
}