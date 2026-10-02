import { Injectable, Logger, OnApplicationBootstrap, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service.js';

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface DiagnosaInfo {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  pcId: string;
}

const DIAGNOSA_DIR = '/data/diagnosa';

// Batas 5 MB: agent sudah membatasi zip-nya ke 4 MB sebelum mengunggah, jadi
// angka ini hanya penjaga kalau ada klien yang mengirim lebih besar.
const MAX_SIZE = 5 * 1024 * 1024;
const RETENSI_HARI = 14;

@Injectable()
export class DiagnosaService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DiagnosaService.name);

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    try {
      fs.mkdirSync(DIAGNOSA_DIR, { recursive: true });
      this.hapusYangKedaluwarsa();
    } catch (err) {
      this.logger.error(`Gagal menyiapkan folder diagnosa: ${err}`);
    }
  }

  /**
   * Simpan paket diagnosa dari agent.
   *
   * Endpoint ini `@Public()` karena agent tidak punya JWT — identitasnya tetap
   * `pcId` + `agentToken`, sama seperti `POST /api/settings/verify-pin`.
   */
  async simpan(pcId: string, agentToken: string, file: UploadedFile): Promise<{ success: boolean; filename: string }> {
    // Validasi identitas DI LUAR lebih dulu: percakapan apa pun soal file
    // tidak boleh dijawab sebelum tahu pengirimnya sah.
    const sah = await this.prisma.pc.findFirst({
      where: { id: pcId, agentToken },
      select: { id: true, namaPc: true },
    });
    if (!sah) {
      throw new UnauthorizedException('pcId atau agentToken tidak cocok');
    }

    if (!file) throw new BadRequestException('File diagnosa tidak ada');
    if (!/\.zip$/i.test(file.originalname)) {
      throw new BadRequestException('File diagnosa harus .zip');
    }
    if (file.size > MAX_SIZE) {
      throw new BadRequestException(`Ukuran maksimal ${Math.floor(MAX_SIZE / 1024 / 1024)} MB`);
    }

    // ⚠️ Nama berkas TIDAK memakai file.originalname dari klien. Nama itu
    // sepenuhnya dikendalikan pengirim, dan dipakai lagi di header
    // Content-Disposition saat unduh. Menyusunnya dari data server sendiri
    // menutup jalur traversal dan header yang rusak sekaligus.
    const stempel = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const slug = sah.namaPc.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'pc';
    const filename = `${stempel}_${slug}_${pcId.slice(0, 8)}.zip`;

    fs.mkdirSync(DIAGNOSA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DIAGNOSA_DIR, filename), file.buffer);

    this.logger.log(`Diagnosa diterima dari ${sah.namaPc}: ${filename} (${file.size} byte)`);
    return { success: true, filename };
  }

  list(): DiagnosaInfo[] {
    if (!fs.existsSync(DIAGNOSA_DIR)) return [];
    return fs
      .readdirSync(DIAGNOSA_DIR)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const stat = fs.statSync(path.join(DIAGNOSA_DIR, f));
        return {
          filename: f,
          sizeBytes: stat.size,
          createdAt: stat.mtime.toISOString(),
          pcId: f.split('_')[2]?.replace(/\.zip$/i, '') ?? '',
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Path file untuk unduhan. `path.basename` wajib: tanpa itu `..` dari
   * parameter route bisa keluar dari folder.
   */
  filePath(filename: string): string {
    const safe = path.basename(filename);
    if (!/\.zip$/i.test(safe)) throw new NotFoundException('Berkas tidak ditemukan');
    const filePath = path.join(DIAGNOSA_DIR, safe);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new NotFoundException('Berkas tidak ditemukan');
    }
    return filePath;
  }

  /** Dipanggil cron tiap hari. Hapus berkas yang umurnya melewati retensi. */
  hapusYangKedaluwarsa(): number {
    try {
      if (!fs.existsSync(DIAGNOSA_DIR)) return 0;
      const batas = Date.now() - RETENSI_HARI * 24 * 60 * 60 * 1000;
      let dihapus = 0;
      for (const f of fs.readdirSync(DIAGNOSA_DIR)) {
        if (!f.endsWith('.zip')) continue;
        const p = path.join(DIAGNOSA_DIR, f);
        try {
          if (fs.statSync(p).mtimeMs < batas) {
            fs.unlinkSync(p);
            dihapus++;
          }
        } catch {
          // satu berkas gagal dihapus tidak boleh menghentikan sisanya
        }
      }
      if (dihapus > 0) this.logger.log(`Diagnosa: ${dihapus} berkas dihapus (retensi ${RETENSI_HARI} hari)`);
      return dihapus;
    } catch (err) {
      this.logger.error(`Cron hapus diagnosa gagal: ${err}`);
      return 0;
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'cleanup-diagnosa' })
  cronBersihkan(): void {
    try {
      this.logger.log('Cron cleanup diagnosa dijalankan');
      this.hapusYangKedaluwarsa();
    } catch (err) {
      this.logger.error(`Cron cleanup diagnosa gagal: ${err}`);
    }
  }
}