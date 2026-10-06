import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AMBANG_OFFLINE_MS } from '../pc/pc-status.js';
import { tanggalWib } from '../common/wib-date.js';

/**
 * Mencatat berapa lama tiap PC menyala, dihitung dari heartbeat.
 *
 * ⚠️ APA YANG TIDAK BISA DILAKUKAN: menghitung ulang dari data yang sudah
 * ada. `Pc.lastHeartbeatAt` hanya menyimpan heartbeat TERAKHIR (ditimpa tiap
 * 15 detik), dan `handleConnection`/`handleDisconnect` tidak menulis apa pun
 * ke database — keduanya cuma mengisi `Map` di memori dan menulis ke
 * `docker logs`. Jadi tidak ada satu pun catatan historis heartbeat, dan
 * grafik hanya bisa terisi mulai dari saat cron ini dijalankan.
 *
 * Yang dihitung di sini:
 * - `GET /api/reports/uptime` → angka menit per PC
 *
 * Sifat penting:
 * - **IDEMPOTEN.** Kalau cron ini berjalan dua kali, atau proses restart di
 *   tengah jalan, angka tidak akan dobel. Yang ditambahkan hanya selisih
 *   sejak `dihitungSampai` yang terakhir.
 * - **Jeda offline tidak terhitung.** Saat PC mati, watermark tetap
 *   dimajukan tanpa menambah `detikOnline`.
 * - **Hanya PC `rusak = false`.** PC yang ditandai rusak tidak muncul di
 *   mana pun, termasuk di sini.
 */
@Injectable()
export class UptimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UptimeService.name);
  private interval: NodeJS.Timeout | null = null;
  private intervalPembersih: NodeJS.Timeout | null = null;
  /** Berapa detik terakhir PC dianggap online oleh tick sebelumnya. */
  private terakhirOnline = new Map<string, number>();

  constructor(private prisma: PrismaService) {}

  onModuleInit(): void {
    // 60 detik, bukan 15 seperti heartbeat. Uptime tidak butuh presisi
    // setempit, dan tabelnya cuma 24 baris per PC per hari.
    this.interval = setInterval(() => {
      void this.catat();
    }, 60_000);
    // Pembersihan cukup sekali sehari.
    this.intervalPembersih = setInterval(() => {
      void this.bersihkan();
    }, 6 * 60 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.intervalPembersih) clearInterval(this.intervalPembersih);
  }

  /**
   * Satu tick pencatatan.
   *
   * Dijalankan dari `setInterval`, jadi SELURUH badannya wajib dibungkus
   * try/catch — satu error apa pun yang jadi unhandled rejection akan
   * menjatuhkan seluruh proses server.
   */
  async catat(): Promise<void> {
    try {
      const sekarang = Date.now();
      // ⚠️ `tanggalWib()` mengembalikan string `YYYY-MM-DD`, dan kolomnya
      // `DATE`. Jadi harus diulpai ke tengah malam UTC — kalau dibuat dari
      // `new Date(...)` dengan zona lokal, tanggalnya bisa bergeser sehari.
      const tanggal = new Date(`${tanggalWib(new Date(sekarang))}T00:00:00.000Z`);

      const pcs = await this.prisma.pc.findMany({
        where: { rusak: false },
        select: { id: true, lastHeartbeatAt: true },
      });

      for (const pc of pcs) {
        const online = pc.lastHeartbeatAt !== null && sekarang - pc.lastHeartbeatAt.getTime() < AMBANG_OFFLINE_MS;
        // ⚠️ try/catch PER PC, bukan cuma satu untuk seluruh fungsi. Tanpa
        // ini, satu PC yang gagal (mis. `findUnique` kena limit koneksi)
        // membuat loop berhenti — dan semua PC setelahnya tidak pernah
        // tercatat sama sekali, tanpa pesan apa pun.
        try {
          await this.tambahDetik(pc.id, tanggal, online, sekarang);
        } catch (e) {
          this.logger.warn(`Pencatatan uptime PC ${pc.id} gagal: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.logger.warn(`Pencatatan uptime gagal: ${(e as Error).message}`);
    }
  }

  /**
   * Tambah durasi online untuk satu PC, dengan aturan anti-dobel.
   *
   * Aturan intis: `dihitungSampai`. Yang ditambahkan hanya selisih antara
   * `sekarang` dan watermark sebelumnya:
   *
   * - Baris baru -> mulai dari `sekarang`, 0 detik. Detik yang hilang sejak
   *   tengah malam tidak dikarang, karena tidak ada bukti heartbeat-nya.
   * - Baris sudah ada -> `delta = sekarang - dihitungSampai`. Kalau PC
   *   offline, delta **tidak** ditambahkan, tapi watermark tetap dimajukan.
   *   Itulah yang membuat jeda offline tidak masuk hitungan.
   * - Kalau watermark menyeberang tengah malam, delta dipotong supaya tidak
   *   ada detik yang dihitung dua kali ke dua hari. Selisihnya maksimal
   *   satu tick (60 detik).
   */
  private async tambahDetik(
    pcId: string,
    tanggal: Date,
    online: boolean,
    sekarang: number,
  ): Promise<void> {
    const baris = await this.prisma.uptimePc.findUnique({
      where: { pcId_tanggal: { pcId, tanggal } },
    });

    if (!baris) {
      await this.prisma.uptimePc.create({
        data: { pcId, tanggal, detikOnline: 0, dihitungSampai: new Date(sekarang) },
      });
      return;
    }

    let deltaDetik = Math.max(0, (sekarang - baris.dihitungSampai.getTime()) / 1000);
    // Mencegah watermark dihitung ulang: delta 0 = tidak menambah apa pun.
    if (baris.dihitungSampai.getTime() > sekarang) {
      deltaDetik = 0;
    }
    // Detik tidak boleh melebihi 24 jam, walau PC nyala terus. Ini menutup
    // kasus sistem sempat mati lalu menyala lagi tanpa sempat mencatat.
    const maksimum = 24 * 60 * 60;
    const tambahan = online
      ? Math.min(Math.floor(deltaDetik), maksimum - baris.detikOnline)
      : 0;

    if (tambahan <= 0) {
      // Tetap majukan watermark, supaya tick berikutnya tidak menghitung
      // ulang jeda yang sudah terlewati.
      await this.prisma.uptimePc.update({
        where: { pcId_tanggal: { pcId, tanggal } },
        data: { dihitungSampai: new Date(sekarang) },
      });
      return;
    }

    await this.prisma.uptimePc.update({
      where: { pcId_tanggal: { pcId, tanggal } },
      data: {
        detikOnline: { increment: tambahan },
        dihitungSampai: new Date(sekarang),
      },
    });
  }

  /** Hapus catatan uptime lebih lama dari 90 hari. */
  async bersihkan(): Promise<void> {
    try {
      const batas = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const hasil = await this.prisma.uptimePc.deleteMany({ where: { tanggal: { lt: batas } } });
      if (hasil.count > 0) {
        this.logger.log(`Pembersihan uptime: ${hasil.count} baris lebih tua dari 90 hari dihapus`);
      }
    } catch (e) {
      this.logger.warn(`Pembersihan uptime gagal: ${(e as Error).message}`);
    }
  }
}
