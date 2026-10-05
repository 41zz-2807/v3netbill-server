import { Injectable, Logger } from '@nestjs/common';
import { AccountType, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { FcmService } from './fcm.service.js';

/**
 * Channel notifikasi di sisi Android.
 *
 * NAMA INI WAJIB SAMA dengan yang dibuat di MainActivity.kt. Kalau berbeda,
 * FCM tetap membalas berhasil, tapi Android memakai channel bawaannya yang
 * importance-nya rendah: notifikasi muncul tanpa suara dan tanpa getaran.
 *
 * Yang dikirim ke FCM hanya `channel_id`. `message.android.notification` tidak
 * punya field untuk nama channel — nama itu hanya dipakai saat channel dibuat
 * di perangkat, dan mengirim field tak dikenal membuat FCM membalas 400 untuk
 * setiap notifikasi.
 */
const CHANNEL_ID = 'sesi_dimulai';

/**
 * Sensor nama member: dua karakter pertama, sisanya disembunyikan.
 *
 * Nama member adalah kredensial login-nya, jadi tidak boleh tampil penuh di
 * layar kunci HP. Dua karakter pertama tetap membuat admin bisa tahu siapa yang
 * sedang main tanpa membuat notifikasi jadi sumber kebocoran.
 *
 * `"Budi Santoso"` → `"Bu***"`
 * `"Bu"` → `"Bu***"`   (nama pendek, tidak lebih pendek dari 2 huruf)
 * `null` → `"-"`
 */
export function sensorNama(nama: string | null | undefined): string {
  const bersih = (nama ?? '').trim();
  if (bersih.length === 0) return '-';
  return `${bersih.slice(0, 2)}***`;
}

@Injectable()
export class NotifikasiService {
  private readonly logger = new Logger(NotifikasiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fcm: FcmService,
  ) {}

  /**
   * Simpan token perangkat milik user yang sedang login.
   *
   * Role TIDAK pernah dibaca dari body permintaan. Kalau dibaca dari sana,
   * kasir cukup mengirim `role: "ADMIN"` untuk mendaftarkan dirinya sebagai
   * penerima notifikasi admin. Role selalu berasal dari relasi User.
   */
  async daftarToken(userId: string, token: string): Promise<boolean> {
    const bersih = token.trim();
    if (bersih === '') return false;

    await this.prisma.perangkat.upsert({
      where: { token: bersih },
      create: { token: bersih, userId, platform: 'android' },
      // Token yang sama bisa pindah tangan kalau HP-nya dipakai user lain.
      // Update userId-nya, kalau tidak token itu akan tetap terkirim ke
      // pemilik lamanya.
      update: { userId, lastSeenAt: new Date() },
    });
    return true;
  }

  /** Hapus token milik pemanggil. Dipanggil saat logout. */
  async hapusToken(userId: string, token: string): Promise<void> {
    const bersih = token.trim();
    if (bersih === '') return;
    await this.prisma.perangkat.deleteMany({ where: { token: bersih, userId } });
  }

  /**
   * Kabari semua perangkat milik user ADMIN bahwa ada pelanggan yang memulai
   * sesi di salah satu PC.
   *
   * Sengaja tidak melempar error ke pemanggil. Pemanggilnya adalah
   * `client:login_request` yaitu jalan yang sedang dipakai pelanggan di
   * komputer: notifikasi yang gagal tidak boleh pernah mengganggu login.
   *
   * `akun` adalah kode voucher atau nama member yang dipakai. Nama member
   * ADALAH kredensial login-nya (`session.service.ts` mencocokkan `nama`), dan
   * notifikasi Android terlihat di layar kunci HP yang bisa dibaca siapa pun.
   * Karena itu nama member hanya terkirim **dua karakter pertama** sisanya
   * disembunyikan — admin tetap bisa tahu siapa yang sedang main tanpa
   * membuat HP jadi sumber kebocoran kredensial.
   */
  async kirimSesiMulai(
    pc: { namaPc: string; tipe: AccountType; kodeUnik?: string | null; nama?: string | null },
    sumber = 'PC',
  ): Promise<void> {
    try {
      const perangkat = await this.prisma.perangkat.findMany({
        where: { user: { role: Role.ADMIN } },
        select: { id: true, token: true },
      });

      if (perangkat.length === 0) return;

      const jenis = pc.tipe === AccountType.MEMBER ? 'Member' : 'Voucher';
      // Voucher memakai kode unik, member memakai nama. Keduanya tidak boleh
      // bocor penuh ke layar kunci.
      const identitas =
        pc.tipe === AccountType.MEMBER
          ? sensorNama(pc.nama)
          : (pc.kodeUnik ?? '-');
      const pesan = {
        judul: 'Sesi dimulai',
        isi: `${jenis} ${identitas} · ${pc.namaPc} (${sumber})`,
        data: { jenis: 'sesi_dimulai', pc: pc.namaPc },
        channelId: CHANNEL_ID,
      };

      const hasil = await Promise.all(
        perangkat.map((p) => this.fcm.kirim(p.token, pesan)),
      );

      const terkirim = hasil.filter((h) => h.ok).length;
      const mati = hasil
        .filter((h) => h.tokenMati)
        .map((h, i) => perangkat[i].id);

      // Token yang ditolak FCM dibersihkan di sini. HP yang di-uninstall atau
      // token yang sudah kedaluwarsa akan selalu ditolak, jadi menyimpan
      // hanya menambah-onsent per notifikasi.
      if (mati.length > 0) {
        await this.prisma.perangkat.deleteMany({ where: { id: { in: mati } } });
        this.logger.log(`${mati.length} token FCM tidak valid lagi, dihapus`);
      }

      const gagal = hasil.filter((h) => !h.ok && !h.tokenMati);
      if (terkirim > 0 || gagal.length > 0) {
        this.logger.log(
          `Notifikasi sesi ${jenis} di ${pc.namaPc}: ${terkirim}/${perangkat.length} terkirim`,
        );
      }
      for (const h of gagal) {
        this.logger.warn(`FCM menolak: ${h.kode ?? '-'} ${h.pesan}`);
      }
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Notifikasi sesi gagal diproses: ${pesan}`);
    }
  }

  /** Hanya untuk upkeep: buang token yang sudah tidak disentuh berhari-hari. */
  async hapusTokenLama(umurHari = 30): Promise<number> {
    const batas = new Date();
    batas.setUTCDate(batas.getUTCDate() - umurHari);
    const hasil = await this.prisma.perangkat.deleteMany({
      where: { lastSeenAt: { lt: batas } },
    });
    return hasil.count;
  }
}
