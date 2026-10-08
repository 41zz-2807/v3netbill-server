import { Injectable, Logger } from '@nestjs/common';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { tanggalWib } from '../common/wib-date.js';

/**
 * Nama berkas log. Tanggal ikut nama berkas, bukan disimpan di dalam, jadi
 * satu berkas = satu hari dan tidak perlu dipilah saat dibaca.
 */
const POLA_NAMA = /^billing-\d{4}-\d{2}-\d{2}\.log$/;
const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

/** Umur berkas sebelum dihapus, sesuai permintaan: 30 hari. */
const UMUR_HARI = 30;

export interface RingkasanLog {
  tanggal: string;
  ukuranBytes: number;
  jumlahBaris: number;
}

export interface IsiLog {
  tanggal: string;
  baris: string[];
  jumlahDitemukan: number;
}

/**
 * Log aktivitas billing dalam berkas teks, satu berkas per hari.
 *
 * Kenapa berkas dan bukan tabel: log ini dibaca manusia dan bisa diambil untuk
 * keperluan lain (laporan, sengketa pelanggan), jadi harus bisa disalin dari
 * host tanpa alat. Tabel `ActivityLog` tetap dipakai untuk halaman jejak
 * aktivitas, jadi ada dua salinan, bukan satu.
 *
 * ⚠️ Berkas TIDAK BOLEH ditulis lewat `join(dir, namaDariUser)` tanpa
 * validasi. Nama berkas berasal dari parameter URL, jadi bentuk
 * `?tanggal=../../.env` akan membaca berkas apa pun di server. Validasi
 * ketat ada di [tanggalHarusValid], dan hasilnya dicek lagi di [jalurBerkas].
 */
@Injectable()
export class LogBillingService {
  private readonly logger = new Logger(LogBillingService.name);

  /**
   * Antrean penulisan. `appendFile` tidak aman kalau dipanggil bersamaan
   * untuk berkas sama: dua baris bisa saling menimpa di tengah. Satu rantai
   * Promise membuat penulisan berurutan tanpa perlu lock.
   */
  private antrean: Promise<void> = Promise.resolve();

  /** Cache nama PC. PC jarang berubah, sementara log bisa ratusan baris sehari. */
  private namaPc = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  private get dirLog(): string {
    return process.env.LOG_BILLING_DIR ?? '/data/logs';
  }

  /**
   * Tolak apa pun yang bukan `YYYY-MM-DD`.
   *
   * Ini satu-satunya tempat yang melindungi filesystem. Regex
   * ketat, bukan `path.basename`, karena `basename('../../etc/passwd')`
   * menghasilkan `passwd` yang lolos padahal pemanggilnya sudah mencoba
   * keluar dari folder.
   */
  private tanggalHarusValid(tanggal: string): string {
    if (!POLA_TANGGAL.test(tanggal)) {
      throw new TanggalLogTidakSahError('Format tanggal harus YYYY-MM-DD.');
    }
    return tanggal;
  }

  /** Jalur berkas, dijamin berada di dalam folder log. */
  private jalurBerkas(tanggal: string): string {
    const sah = this.tanggalHarusValid(tanggal);
    const penuh = resolve(join(this.dirLog, `billing-${sah}.log`));
    const dasar = resolve(this.dirLog);
    if (!penuh.startsWith(dasar + sep)) {
      throw new TanggalLogTidakSahError('Tanggal tidak sah.');
    }
    return penuh;
  }

  /** Tanggal yang punya berkas, terbaru dulu. */
  private async daftarTanggal(): Promise<string[]> {
    try {
      const nama = await readdir(this.dirLog);
      return nama
        .filter((n) => POLA_NAMA.test(n))
        .map((n) => n.slice('billing-'.length, -'.log'.length))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      // Folder belum ada berarti belum ada log. Kondisi normal, bukan error.
      return [];
    }
  }

  /**
   * Buang cache nama PC.
   *
   * ⚠️ WAJIB dipanggil setiap kali `namaPc` berubah. Cache di
   * `namaPcUntuk()` hanya diisi ulang saat masih kosong, jadi tanpa ini
   * seluruh baris log SETELAH PC diganti namanya akan tetap memakai nama
   * LAMA — persis kebalikan dari tujuan operator yang mengganti nama.
   */
  invalidateNamaPc(): void {
    this.namaPc = new Map();
  }

  private async namaPcUntuk(pcId: string | null | undefined): Promise<string> {
    if (!pcId) return '';
    const cached = this.namaPc.get(pcId);
    if (cached) return cached;

    // Cache miss terjadi paling banyak sekali per PC, bukan sekali per event.
    if (this.namaPc.size === 0) {
      try {
        const semua = await this.prisma.pc.findMany({
          select: { id: true, namaPc: true },
        });
        this.namaPc = new Map(semua.map((p) => [p.id, p.namaPc]));
      } catch {
        return pcId;
      }
    }
    return this.namaPc.get(pcId) ?? pcId;
  }

  /**
   * Catat satu aktivitas. Tidak pernah melempar error.
   *
   * Kegagalan menulis log TIDAK boleh menggagalkan operasi yang sedang
   * berjalan: sesi yang sedang berjalan atau transaksi yang sudah tersimpan
   * tidak bisa dibatalkan hanya karena disk penuh.
   */
  tulis(event: string, payload: Record<string, unknown>): void {
    this.antrean = this.antrean
      .then(() => this.tulisBaris(event, payload))
      .catch((e) => {
        const pesan = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Gagal menulis log billing: ${pesan}`);
      });
  }

  private async tulisBaris(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const namaPc = await this.namaPcUntuk(payload['pcId'] as string | undefined);
    const baris =
      `${new Date().toISOString()} | ${labelEvent(event)} | ` +
      `${susunFields(payload, namaPc)}\n`;

    await mkdir(this.dirLog, { recursive: true });
    await appendFile(this.jalurBerkas(hariIni()), baris, 'utf8');
  }

  /** Daftar berkas yang tersedia, terbaru dulu. */
  async daftar(): Promise<RingkasanLog[]> {
    const hasil: RingkasanLog[] = [];
    for (const tanggal of await this.daftarTanggal()) {
      try {
        const jalur = this.jalurBerkas(tanggal);
        const info = await stat(jalur);
        const isi = await readFile(jalur, 'utf8');
        hasil.push({
          tanggal,
          ukuranBytes: info.size,
          jumlahBaris: isi === '' ? 0 : isi.split('\n').length - 1,
        });
      } catch {
        // Berkas hilang di antara readdir dan stat. Lewati saja.
      }
    }
    return hasil;
  }

  /**
   * Baca isi satu hari, dengan pencarian opsional.
   *
   * [cari] diterapkan ke isi yang sudah dibaca di memory, tidak pernah ke
   * filesystem. Jadi pola aneh di kotak pencarian tidak bisa membuat
   * server terbebani.
   *
   * ⚠️ Validasi tanggal DI LUAR try/catch. Versi pertama memanggilnya di
   * dalam try, lalu `catch` yang menangkap "file tidak ada" ikut
   * menelan error validasi. Akibatnya `?tanggal=../../.env` dijawab 200
   * dengan hasil kosong, bukan 400. Isinya memang tidak bocor — `readFile`
   * tidak pernah terpanggil karena validasi melempat lebih dulu — tapi
   * jawabannya berbohong dan tidak ada yang bisa mempercayai 400-nya.
   */
  async baca(tanggal: string, cari?: string): Promise<IsiLog> {
    const jalur = this.jalurBerkas(tanggal);

    let isi = '';
    try {
      isi = await readFile(jalur, 'utf8');
    } catch {
      // Tidak ada log untuk tanggal itu. Kembalikan kosong, bukan error:
      // memilih tanggal tanpa log itu kondisi normal, bukan kegagalan.
      return { tanggal, baris: [], jumlahDitemukan: 0 };
    }

    const semua = isi === '' ? [] : isi.split('\n').filter((b) => b !== '');
    const cariHurufKecil = cari?.trim().toLowerCase() ?? '';
    const hasil =
      cariHurufKecil === ''
        ? semua
        : semua.filter((b) => b.toLowerCase().includes(cariHurufKecil));

    return { tanggal, baris: hasil, jumlahDitemukan: hasil.length };
  }

  /**
   * Isi mentah untuk diunduh sebagai .txt.
   *
   * ⚠️ Nama berkasnya dibangun dari tanggal yang sudah lolos validasi, bukan
   * dari input mentah. Versi pertama memakai input mentah, dan tanda kutip
   * di dalamnya keluar dari nilai header `Content-Disposition` sehingga
   * `attachment; filename="log-billing-.." x.txt"` — header sudah rusak
   * sebelum diunduh.
   */
  async unduh(tanggal: string): Promise<{ isi: string; nama: string }> {
    const sah = this.tanggalHarusValid(tanggal);
    let isi = '';
    try {
      isi = await readFile(this.jalurBerkas(sah), 'utf8');
    } catch {
      isi = '';
    }
    return { isi, nama: `log-billing-${sah}.txt` };
  }

  /**
   * Hapus berkas yang lebih tua dari 30 hari.
   *
   * Dipakai cron, dan juga sekali saat server start supaya folder tidak
   * tumbuh terus kalau server sempat mati berhari-hari.
   */
  async hapusLama(umurHari = UMUR_HARI): Promise<number> {
    // `setDate` memakai jam lokal server — sejak 7 Okt container memakai TZ
    // Asia/Jakarta (dulu UTC). Aman di sini karena yang dipakai hanya
    // tanggalnya, dan selisih zona tidak cukup untuk melewati ambang tanggal
    // pada jendela retensi 30 hari.
    const batas = new Date();
    batas.setDate(batas.getDate() - umurHari);
    const batasTgl = tanggalWib(batas);

    let terhapus = 0;
    for (const tanggal of await this.daftarTanggal()) {
      // Nama berkas sudah tervalidasi formatnya, jadi perbandingan string
      // dengan YYYY-MM-DD aman untuk urut tanggal.
      if (tanggal < batasTgl) {
        try {
          await unlink(this.jalurBerkas(tanggal));
          terhapus++;
        } catch {
          // Sudah hilang atau tidak boleh dihapus. Lanjut.
        }
      }
    }
    if (terhapus > 0) {
      this.logger.log(
        `${terhapus} berkas log lebih tua dari ${umurHari} hari dihapus`,
      );
    }
    return terhapus;
  }
}

function hariIni(): string {
  // ⚠️ WAJIB tanggal WIB, bukan `new Date().toISOString().slice(0, 10)`.
  // `toISOString()` mengembalikan tanggal **UTC**, dan WIB = UTC + 7 jam.
  // Between 00:00 dan 06:59 WIB, tanggal UTC masih milik HARI SEBELUMNYA —
  // jadi aktivitas jam-jam itu masuk berkas `billing-<kemarin>.log`.
  return tanggalWib();
}

/**
 * Error untuk tanggal tidak sah.
 *
 * Sengaja kelas sendiri, bukan `BadRequestException` dari Nest, supaya file
 * ini tidak mengimpor apa pun dari framework. Controller yang memetakan
 * error ini ke HTTP 400.
 */
class TanggalLogTidakSahError extends Error {
  constructor(pesan: string) {
    super(pesan);
    this.name = 'TanggalLogTidakSah';
  }
}

/** Label yang enak dibaca orang, bukan nama event internal. */
function labelEvent(event: string): string {
  // Event yang tidak dikenal tetap ditulis apa adanya. Membuangnya berarti
  // aktivitas yang tidak teridentifikasi hilang dari log.
  return LABEL_EVENT[event] ?? event;
}

const LABEL_EVENT: Record<string, string> = {
  'session:started': 'Sesi Berjalan',
  'session:started_dashboard': 'Sesi Berjalan',
  'session:stopped': 'Sesi Berakhir',
  'transaction:created': 'Transaksi',
  'voucher:created_dashboard': 'Voucher Dibuat',
  'account:revoked': 'Akun Dinonaktifkan',
  'account:password_changed': 'Password Akun Diubah',
  'auth:login': 'Login Operator',
  'auth:login_gagal': 'Login Gagal',
  pc_lock: 'PC Dikunci',
  pc_locked: 'PC Dikunci',
  pc_unlock: 'PC Dibuka',
  pc_unlocked: 'PC Dibuka',
  pc_shutdown: 'PC Dimatikan',
  pc_shutdown_auto: 'PC Mati Otomatis',
};

/** Field yang ditulis, berurutan supaya log mudah dipindai mata. */
const URUT_FIELD: [string, string][] = [
  ['pc', 'pc'],
  ['akun', 'akun'],
  ['tipe', 'tipe'],
  ['jenis', 'jenis'],
  ['nominal', 'nominal'],
  ['durasiMenit', 'durasi'],
  ['durasiDetik', 'durasi'],
  ['durasiTerpakaiDetik', 'dipakai'],
  ['sisaWaktuKembali', 'sisaKembali'],
  ['sisaWaktuDetik', 'sisa'],
  ['alasan', 'alasan'],
  // Menit idle dicatat sebagai angka sendiri, bukan disembunyikan di
  // `keterangan` — biar saat membaca log tahu pasti berapa lama PC nganggur.
  ['menit', 'idleMenit'],
  ['kasir', 'kasir'],
  ['sandiDiubah', 'sandiDiubah'],
  ['sesiDihentikan', 'sesiDihentikan'],
  ['keterangan', 'keterangan'],
];

/**
 * Susun bagian `key=value`.
 *
 * Ambil dari allow-list, bukan seluruh payload. Id internal (sessionId,
 * accountId, private_key) tidak boleh bocor ke berkas yang dibaca orang dan
 * sengaja diunduh.
 */
function susunFields(payload: Record<string, unknown>, namaPc: string): string {
  const sumber: Record<string, unknown> = {
    pc: namaPc,
    akun:
      (payload['akun'] as string) ??
      (payload['kodeUnik'] as string) ??
      (payload['kode'] as string) ??
      (payload['nama'] as string) ??
      null,
    tipe: payload['tipe'] ?? null,
    jenis: payload['jenis'] ?? null,
    nominal: payload['nominal'] ?? null,
    durasiMenit: payload['durasiMenit'] ?? null,
    durasiDetik: payload['durasiDetik'] ?? null,
    durasiTerpakaiDetik: payload['durasiTerpakaiDetik'] ?? null,
    sisaWaktuKembali: payload['sisaWaktuKembali'] ?? null,
    sisaWaktuDetik: payload['sisaWaktuDetik'] ?? null,
    alasan: payload['alasan'] ?? null,
    // Menit idle untuk auto-matikan. Number 0 di-cast ke string supaya tidak
    // dianggap kosong — justru `0` yang paling perlu terlihat di log.
    menit: payload['menit'] === undefined ? null : String(payload['menit']),
    // `username` dipakai untuk baris login, `by` untuk aktivitas dari
    // dashboard. Keduanya nama orang yang melakukan aksi, jadi satu kolom.
    kasir: (payload['by'] as string) ?? (payload['username'] as string) ?? null,
    sandiDiubah: payload['sandiDiubah'] ?? null,
    sesiDihentikan: payload['sesiDihentikan'] ?? null,
    keterangan: payload['keterangan'] ?? null,
  };

  const bagian: string[] = [];
  for (const [kunci, nama] of URUT_FIELD) {
    const nilai = sumber[kunci];
    if (nilai === null || nilai === undefined || nilai === '') continue;
    bagian.push(`${nama}=${nilai}`);
  }
  return bagian.length > 0 ? bagian.join(' ') : '-';
}
