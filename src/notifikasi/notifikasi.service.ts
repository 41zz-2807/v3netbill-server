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


/**
 * Format detik jadi "1j 20m" / "45m" / "30d".
 *
 * ⚠️ Versi lokal, BUKAN `formatDuration` dari frontend: backend tidak punya
 * akses ke helper itu, dan menariknya ke sini hanya akan menambah
 * ketergantungan. Yang dipakai notifikasi hanya perlu survive, bukan
 * presisi detik — jadi pembulatan ke menit sudah cukup.
 */
function formatDurasi(detik: number): string {
  const d = Math.max(0, Math.floor(detik));
  if (d < 60) return `${d} dtk`;
  const menit = Math.floor(d / 60);
  if (menit < 60) return `${menit}m`;
  const jam = Math.floor(menit / 60);
  if (jam < 24) {
    const sisaMenit = menit % 60;
    return sisaMenit > 0 ? `${jam}j ${sisaMenit}m` : `${jam}j`;
  }
  return `${Math.floor(jam / 24)}h ${jam % 24}j`;
}

@Injectable()
export class NotifikasiService {
  private readonly logger = new Logger(NotifikasiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fcm: FcmService,
  ) {}

  /**
   * Satu-satunya jalan keluar notifikasi: kirim ke perangkat admin, bersihkan
   * token yang ditolak FCM, lalu catat hasilnya.
   *
   * ⚠️ Token mati WAJIB Dicari memakai indeks aslinya. Versi lama menulis
   * `hasil.filter((h) => h.tokenMati).map((h, i) => perangkat[i].id)`, dan
   * `i` di situ adalah indeks DARI ARRAY HASIL FILTER, bukan dari `perangkat`.
   * Kalau hanya token perangkat kedua yang ditolak FCM, yang terhapus adalah
   * token perangkat PERTAMA yang masih hidup -- dan admins itu langsung
   * berhenti menerima notifikasi, tanpa satu pun error yang terlihat.
   */
  private async kirimKeAdmin(
    pesan: {
      judul: string;
      isi: string;
      data: Record<string, string>;
      channelId: string;
    },
    label: string,
  ): Promise<void> {
    const perangkat = await this.prisma.perangkat.findMany({
      where: { user: { role: Role.ADMIN } },
      select: { id: true, token: true },
    });

    if (perangkat.length === 0) return;

    const hasil = await Promise.all(
      perangkat.map((p) => this.fcm.kirim(p.token, pesan)),
    );
    const terkirim = hasil.filter((h) => h.ok).length;

    // ⚠️ Indeks diambil sebelum disaring. Lihat catatan di atas.
    const mati = hasil
      .map((h, i) => ({ tokenMati: h.tokenMati, id: perangkat[i].id }))
      .filter((x) => x.tokenMati)
      .map((x) => x.id);

    if (mati.length > 0) {
      await this.prisma.perangkat.deleteMany({ where: { id: { in: mati } } });
      this.logger.log(`${mati.length} token FCM tidak valid lagi, dihapus`);
    }

    const gagal = hasil.filter((h) => !h.ok && !h.tokenMati);
    if (terkirim > 0 || gagal.length > 0) {
      this.logger.log(`${label}: ${terkirim}/${perangkat.length} terkirim`);
    }
    for (const h of gagal) {
      this.logger.warn(`FCM menolak: ${h.kode ?? '-'} ${h.pesan}`);
    }
  }

  /** Identitas akun untuk ditampilkan, dengan nama member selalu disensor. */
  private static identitas(
    tipe: AccountType,
    kodeUnik?: string | null,
    nama?: string | null,
  ): { jenis: string; identitas: string } {
    const jenis = tipe === AccountType.MEMBER ? 'Member' : 'Voucher';
    // Voucher memakai kode unik, member memakai nama. Keduanya tidak boleh
    // bocor penuh ke layar kunci HP.
    const identitas =
      tipe === AccountType.MEMBER ? sensorNama(nama) : (kodeUnik ?? '-');
    return { jenis, identitas };
  }

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
  /**
   * Kabari admin bahwa sesi berhenti karena KONEKSI AGENT TERPUTUS.
   *
   * 🔴 Bedanya dari notifikasi "sesi dimulai": di sini yang paling penting
   * adalah "PC005 · Member bu*** · koneksi terputus, sisa 1j 20m dikembalikan".
   * Sisa waktu yang dikembalikan adalah informasi yang paling operasional —
   * kasir di luar area PC baru tahu kalau ada pelanggan yang kehilangan waktu.
   *
   * ⚠️ Nama member tetap disensor sama seperti notifikasi sesi dimulai.
   * Notifikasi ini muncul di layar KUNCI HP, jadi identitas akun tidak boleh
   * bocor penuh di sini juga.
   */
  async kirimSesiTerputus(
    pc: { namaPc: string; tipe: AccountType; kodeUnik?: string | null; nama?: string | null },
    sisaKembaliDetik: number,
  ): Promise<void> {
    try {
      const { jenis, identitas } = NotifikasiService.identitas(
        pc.tipe,
        pc.kodeUnik,
        pc.nama,
      );

      // Sisa 0 berarti tidak ada yang bisa dikembalikan (mis. sesi yang
      // terputus setelah waktunya habis). Kalimatnya harus jujur, jangan
      // menjanjikan pengembalian yang tidak terjadi.
      const kembalian =
        sisaKembaliDetik > 0 ? `sisa ${formatDurasi(sisaKembaliDetik)} dikembalikan` : 'tanpa sisa';

      await this.kirimKeAdmin(
        {
          judul: 'Koneksi terputus',
          isi: `${jenis} ${identitas} · ${pc.namaPc} · ${kembalian}`,
          data: { jenis: 'sesi_terputus', pc: pc.namaPc },
          channelId: CHANNEL_ID,
        },
        `Notifikasi sesi terputus di ${pc.namaPc}`,
      );
    } catch (err) {
      // ⚠️ Tidak pernah melempar. Sesi pelanggan sudah berhenti saat
      // method ini dipanggil; notifikasi yang gagal tidak boleh mengubah apa pun.
      this.logger.warn(
        `Gagal mengirim notifikasi sesi terputus: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Kabari berapa lama pelanggan benar-benar bermain, saat sesi berhenti
   * karena aksi kasir atau waktu habis.
   *
   * 🔴 Alasan kenapa ini perlu method sendiri: notifikasi "sesi
   * dimulai" tidak bisa menjawab pertanyaan ini, karena durasi baru diketahui
   * setelah sesi berakhir -- bukan saat dimulai. Dan notifikasi "koneksi
   * terputus" sengaja TIDAK dipakai di sini, supaya disconnect_timeout tetap
   * terbaca sebagai masalah yang perlu ditindak, bukan sekadar "selesai".
   */
  async kirimSesiSelesai(
    pc: { namaPc: string; tipe: AccountType; kodeUnik?: string | null; nama?: string | null },
    durasiTerpakaiDetik: number,
    sisaKembaliDetik: number,
  ): Promise<void> {
    try {
      const { jenis, identitas } = NotifikasiService.identitas(
        pc.tipe,
        pc.kodeUnik,
        pc.nama,
      );

      // ⚠️ Durasi yang ditulis adalah yang BENAR-BENAR terpakai, bukan
      // total saldo akun. Kalau bukan, notifikasi akan sering salah
      // setiap kali sesi berhenti lebih awal.
      const main = formatDurasi(Math.max(0, Math.floor(durasiTerpakaiDetik)));

      // ⚠️ Sisa 0 ditulis "tanpa sisa", bukan disembunyikan. Waktu
      // habis memang tidak mengembalikan apa pun, dan operator harus bisa
      // membedakannya dari sesi yang dihentikan kasir dengan sisa 1 menit.
      const kembalian =
        sisaKembaliDetik > 0
          ? `sisa ${formatDurasi(sisaKembaliDetik)} dikembalikan`
          : 'tanpa sisa';

      await this.kirimKeAdmin(
        {
          judul: 'Sesi selesai',
          isi:
            `${jenis} ${identitas} · ${pc.namaPc} · ` +
            `main ${main} · ${kembalian}`,
          data: {
            jenis: 'sesi_selesai',
            pc: pc.namaPc,
            durasiDetik: String(Math.max(0, Math.floor(durasiTerpakaiDetik))),
          },
          channelId: CHANNEL_ID,
        },
        `Notifikasi sesi selesai di ${pc.namaPc}`,
      );
    } catch (err) {
      this.logger.warn(
        `Gagal mengirim notifikasi sesi selesai: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async kirimSesiMulai(
    pc: { namaPc: string; tipe: AccountType; kodeUnik?: string | null; nama?: string | null },
    sumber = 'PC',
  ): Promise<void> {
    try {
      const { jenis, identitas } = NotifikasiService.identitas(
        pc.tipe,
        pc.kodeUnik,
        pc.nama,
      );
      await this.kirimKeAdmin(
        {
          judul: 'Sesi dimulai',
          isi: `${jenis} ${identitas} · ${pc.namaPc} (${sumber})`,
          data: { jenis: 'sesi_dimulai', pc: pc.namaPc },
          channelId: CHANNEL_ID,
        },
        `Notifikasi sesi ${jenis} di ${pc.namaPc}`,
      );
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
