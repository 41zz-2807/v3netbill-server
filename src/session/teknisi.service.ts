import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Akses teknisi ke layar kunci PC CLIENT.
 *
 * ⚠️ Berdiri sendiri dari `Account`, dan itu bukan pilihan gaya:
 *   1. `Account` selalu menghasilkan `Session` + `Transaction` yang ikut rekap
 *      pendapatan. Teknisi justru harus TIDAK masuk hitungan itu.
 *   2. `Account.nama` adalah kredensial login pelanggan dan tampil di daftar
 *      akun — tidak pantas untuk kredensial teknisi.
 *
 * Sesi teknisi juga TIDAK memakai tabel `Session` sama sekali. Alasannya ada di
 * skema: `Session.accountId` punya FK `RESTRICT` yang tidak boleh null, jadi
 * memakainya berarti mengubah jalur yang sedang menagih pelanggan.
 *
 * Setiap method yang dibaca dari jalur login/session tidak pernah melempar ke
 * pemanggilnya — lihat catatan try/catch di tiap method. Alasannya sama seperti
 * `broadcastPcUpdate()`: pemanggilnya tidak selalu `await`, jadi penolakan yang
 * lolos menjadi unhandled rejection.
 */
/**
 * ⚠️ BATAS PENTING — cerminan langsung dari `Agent.Overlay/MainWindow.xaml`.
 *
 * ```
 * KodeTextBox   MaxLength="6"
 * PasswordBox   MaxLength="4"
 * ```
 *
 * Field login di PC client memotong ketikan lebih dari itu, jadi kredensial
 * yang lebih panjang **tidak akan bisa diketik sama sekali** — bukan ditolak
 * server, tapi tidak pernah sampai.
 *
 * Ini sebabnya validasi di `simpanAkun()` memakai angka ini, bukan angka
 * bebas. Membuat akun dengan nama 10 karakter terlihat "berhasil" di halaman
 * Pengaturan, padahal teknisi tidak akan pernah bisa login sama sekali.
 *
 * Menaikkan batas berarti mengubah XAML + membangun MSI baru. Sampai itu
 * dilakukan, angka di sini yang dipakai — dan harus selalu sama dengan XAML.
 */
export const BATAS_LOGIN_PC = { kode: 6, pin: 4 } as const;


@Injectable()
export class TeknisiService {
  private readonly logger = new Logger(TeknisiService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Coba login sebagai teknisi.
   *
   * nonaktif, atau password salah.
   *
   * ⚠️ Jangan bedakan ketiga kasus itu di pesan yang tampil ke pengguna. Kalau
   * "kode dikenal tapi PIN salah" dibedakan dari "kode tidak dikenal", orang
   * yang menebak-nebak di PC client bisa memetakan kode mana yang terdaftar.
   * Untuk akun pelanggan, `loginRequest()` menjawab "Akun tidak ditemukan" —
   * jadi keduanya harus terlihat sama dari luar.
   */
  async verifikasiLogin(
    kode: string,
    password: string,
  ): Promise<{ username: string } | null> {
    try {
      const bersih = kode?.trim() ?? '';
      if (!bersih || !password) {
        return null;
      }
      const akun = await this.prisma.teknisi.findUnique({ where: { username: bersih } });
      if (!akun || !akun.aktif) {
        return null;
      }
      // bcrypt.compare di-import lazy supaya file ini tidak memaksa pemanggil
      // punya dependency bcrypt saat hanya butuh daftar sesi.
      const bcrypt = await import('bcrypt');
      const cocok = await bcrypt.default.compare(password, akun.passwordHash);
      return cocok ? { username: akun.username } : null;
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Verifikasi login teknisi gagal: ${pesan}`);
      return null;
    }
  }

  /**
   * Username teknisi yang sedang aktif.
   *
   * Dipakai gateway sebagai filter MURAH sebelum `verifikasiLogin()`: tanpa
   * ini, setiap login pelanggan di PC client akan kena satu query bcrypt.
   * Daftar sengaja dikembalikan sebagai array supaya bisa dipakai `includes()`.
   */
  async namaTeknisiAktif(): Promise<string[]> {
    try {
      const semua = await this.prisma.teknisi.findMany({
        where: { aktif: true },
        select: { username: true },
      });
      return semua.map((t) => t.username);
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Baca daftar teknisi aktif gagal: ${pesan}`);
      return [];
    }
  }

  /** Sesi teknisi yang masih berjalan di sebuah PC, atau `null`. */
  async sesiAktif(pcId: string): Promise<{ username: string; mulaiAt: Date } | null> {
    try {
      const sesi = await this.prisma.sesiTeknisi.findFirst({
        where: { pcId, selesaiAt: null },
        orderBy: { mulaiAt: 'desc' },
      });
      return sesi ? { username: sesi.username, mulaiAt: sesi.mulaiAt } : null;
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Baca sesi teknisi PC ${pcId} gagal: ${pesan}`);
      return null;
    }
  }

  /**
   * Sesi teknisi yang masih berjalan di SEMUA PC.
   *
   * Dipakai untuk (a) mengisi field `teknisi` di dashboard, dan (b) mengirim
   * ulang state ke agent setelah server restart — supaya indikator dashboard
   * tetap jujur walaupun proses baru saja start.
   */
  async semuaSesiAktif(): Promise<Array<{ pcId: string; username: string; mulaiAt: Date }>> {
    try {
      return await this.prisma.sesiTeknisi.findMany({
        where: { selesaiAt: null },
        orderBy: { mulaiAt: 'desc' },
      });
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Daftar sesi teknisi aktif gagal: ${pesan}`);
      return [];
    }
  }

  /**
   * Tandai teknisi sedang memakai sebuah PC.
   *
   * Baris lama untuk PC yang sama ditutup lebih dulu supaya satu PC tidak
   * punya dua baris terbuka — tanpa itu, matikan sakelar hanya akan
   * mengunci satu dari dua.
   */
  async mulaiSesi(pcId: string, username: string): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.sesiTeknisi.updateMany({
          where: { pcId, selesaiAt: null },
          data: { selesaiAt: new Date() },
        }),
        this.prisma.sesiTeknisi.create({ data: { pcId, username } }),
      ]);
      this.logger.log(`Teknisi ${username} mulai memakai PC ${pcId}`);
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      // Melempar di sini berarti dashboard tidak akan menampilkan teknisi —
      // lebih baik PC tetap terbuka daripada tidak bisa dikunci nanti.
      this.logger.warn(`Gagal mencatat sesi teknisi di PC ${pcId}: ${pesan}`);
    }
  }

  /** Tandai sesi teknisi di sebuah PC sudah selesai. */
  async selesaiSesi(pcId: string): Promise<void> {
    try {
      await this.prisma.sesiTeknisi.updateMany({
        where: { pcId, selesaiAt: null },
        data: { selesaiAt: new Date() },
      });
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Gagal menutup sesi teknisi PC ${pcId}: ${pesan}`);
    }
  }

  /** Tutup SEMUA sesi teknisi. Dipakai saat sakelar dimatikan. */
  async selesaiSemuaSesi(): Promise<number> {
    try {
      const hasil = await this.prisma.sesiTeknisi.updateMany({
        where: { selesaiAt: null },
        data: { selesaiAt: new Date() },
      });
      return hasil.count;
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Gagal menutup semua sesi teknisi: ${pesan}`);
      return 0;
    }
  }

  /**
   * Tutup sesi teknisi yang sedang berjalan di satu PC.
   *
   * ⚠️ Dipakai oleh `unlockPc()` sehingga tombol STOP di layar PC client
   * benar-benar bekerja. Tanpa ini, `unlockPc()` hanya mencari baris `Session`
   * — dan teknisi sengaja **tidak punya** baris itu, jadi hasilnya "tidak ada
   * sesi aktif" dan PC tetap terbuka tanpa jalan keluar selain dashboard.
   *
   * Mengembalikan username-nya kalau memang ada sesi yang ditutup, `null`
   * kalau tidak (agar pemanggil tahu tidak perlu mengunci layar).
   */
  /** Apakah ada teknisi yang sedang memakai PC ini? */
  async adaSesiAktifUntukPc(pcId: string): Promise<boolean> {
    const hasil = await this.prisma.sesiTeknisi.findFirst({
      where: { pcId, selesaiAt: null },
      select: { id: true },
    });
    return hasil !== null;
  }

  async selesaiSesiUntukPc(pcId: string): Promise<string | null> {
    const hasil = await this.prisma.sesiTeknisi.updateMany({
      where: { pcId, selesaiAt: null },
      data: { selesaiAt: new Date() },
    });
    if (hasil.count === 0) return null;
    const sesi = await this.prisma.sesiTeknisi.findFirst({
      where: { pcId },
      select: { username: true },
      orderBy: { mulaiAt: 'desc' },
    });
    return sesi?.username ?? 'teknisi';
  }

  /**
   * Hapus akun teknisi.
   *
   * ⚠️ Sesi yang sedang berjalan harus dikunci oleh pemanggil (controller)
   * SEBELUM akun dihapus. Kalau tidak, teknisi tetap bisa memakai PC sampai
   * logout manual padahal akunnya sudah dihapus dari server.
   */
  async hapusAkun(username: string): Promise<string[]> {
    const sesi = await this.semuaSesiAktif();
    const pcIds = [...new Set(sesi.filter((s) => s.username === username).map((s) => s.pcId))];
    await this.selesaiSemuaSesi();
    await this.prisma.teknisi.deleteMany({ where: { username } });
    this.logger.warn(
      `Akun teknisi ${username} dihapus — ${pcIds.length} PC harus dikunci`,
    );
    return pcIds;
  }

  // ===== ADMIN: manajemen akun =====

  async daftarAkun(): Promise<Array<{ username: string; aktif: boolean; adaSesi: number }>> {
    const semua = await this.prisma.teknisi.findMany({ orderBy: { username: 'asc' } });
    const berjalan = await this.prisma.sesiTeknisi.groupBy({
      by: ['username'],
      where: { selesaiAt: null },
      _count: { _all: true },
    });
    const peta = new Map(berjalan.map((b) => [b.username, b._count._all]));
    return semua.map((t) => ({
      username: t.username,
      aktif: t.aktif,
      adaSesi: peta.get(t.username) ?? 0,
    }));
  }

  /**
   * Buat atau perbarui akun teknisi.
   *
   * ⚠️ `username` tidak boleh sama dengan nama/kode akun pelanggan yang sudah
   * ada. Kalau boleh, kode `teknisi` akan cocok ke DUA tempat: password teknisi
   * yang bocor berarti bisa dipakai masuk sebagai pelanggan, dan sebaliknya.
   * Ini ditolak di server, bukan hanya dicegah di form.
   */
  async simpanAkun(username: string, password?: string): Promise<{ username: string }> {
    // ⚠️ WAJIB `BadRequestException`, bukan `Error` polos. `Error` polos jadi
    // HTTP 500 dengan pesan generik, jadi operator tidak pernah tahu KENAPA
    // pengajuannya ditolak — padahal pesan di bawah ini justru satu-satunya
    // petunjuk baginya.
    const bersih = username?.trim() ?? '';
    if (!bersih) {
      throw new BadRequestException('Nama teknisi tidak boleh kosong');
    }
    // ⚠️ Diperiksa di SINI, bukan hanya di UI — karena batasnya berasal dari
    // agent yang tidak bisa diubah dari server, jadi ini satu-satunya tempat
    // bisa mencegah orang membuat akun yang tidak akan pernah bisa dipakai.
    if (bersih.length > BATAS_LOGIN_PC.kode) {
      throw new BadRequestException(
        `Nama teknisi maksimal ${BATAS_LOGIN_PC.kode} karakter. ` +
          'Field login di layar PC hanya menerima itu, jadi nama yang lebih panjang ' +
          'tidak akan bisa diketik.',
      );
    }
    if (password !== undefined && password !== '' && password.length > BATAS_LOGIN_PC.pin) {
      throw new BadRequestException(
        `PIN teknisi maksimal ${BATAS_LOGIN_PC.pin} karakter. ` +
          'Field password di layar PC hanya menerima itu.',
      );
    }

    const bentrok = await this.prisma.account.findFirst({
      where: { OR: [{ nama: bersih }, { kodeUnik: bersih }] },
      select: { id: true },
    });
    if (bentrok) {
      throw new BadRequestException(
        `Nama "${bersih}" sudah dipakai akun pelanggan. Pilih nama lain supaya kode login tidak ambigu.`,
      );
    }

    const ada = await this.prisma.teknisi.findUnique({ where: { username: bersih } });
    if (!ada) {
      // ⚠️ PIN wajib saat MEMBUAT. `password!` di bawah memakai tanda pil
      // bukan untuk nullable, tapi karena "pasti ada" — dan asumsi itu salah:
      // form mengizinkan PIN kosong, jadi `hash(undefined)` melempar TypeError
      // yang berubah jadi 500. Akun pun tidak jadi dibuat, jadi operator
      // melihat "gagal" tanpa tahu kenapa.
      // PIN kosong HANYA sah saat MEMPERBARUI akun yang sudah ada.
      if (password === undefined || password === '') {
        throw new BadRequestException('PIN wajib diisi saat membuat akun teknisi baru');
      }
      const bcrypt = await import('bcrypt');
      await this.prisma.teknisi.create({
        data: { username: bersih, passwordHash: await bcrypt.default.hash(password, 10) },
      });
      return { username: bersih };
    }

    if (password !== undefined && password !== '') {
      const bcrypt = await import('bcrypt');
      await this.prisma.teknisi.update({
        where: { username: bersih },
        data: { passwordHash: await bcrypt.default.hash(password, 10) },
      });
    }
    return { username: bersih };
  }

  /**
   * Nyalakan / matikan akses teknisi.
   *
   * ⚠️ Mengembalikan DAFTAR `pcId` yang harus dikunci — diambil SEBELUM sesi
   * ditutup.
   *
   * Ini urutan yang Wajib. Versi pertama menutup semua sesi lebih dulu, lalu
   * gateway dipanggil untuk mengunci — sehingga `semuaSesiAktif()` sudah
   * mengembalikan nol dan TIDAK ADA PC yang terkunci, padahal log sudah
   * menulis "1 sesi harus dikunci". Gejalanya: sakelar terlihat berhasil,
   * `terkunci: 0` terkirim ke frontend, tapi teknisi masih bebas di dalam PC.
   *
   * Dengan mengembalikan daftar PC-nya, gateway tidak perlu menebak dan tidak
   * bergantung pada urutan lagi.
   */
  async setAktif(
    aktif: boolean,
  ): Promise<{ aktif: boolean; pcHarusDikunci: string[] }> {
    await this.prisma.teknisi.updateMany({ data: { aktif } });
    const pcHarusDikunci = aktif ? [] : await this.pcDenganSesiAktif();
    if (!aktif && pcHarusDikunci.length > 0) {
      await this.selesaiSemuaSesi();
    }
    this.logger.warn(
      `Akses teknisi ${aktif ? 'DINYALAKAN' : 'DIMATIKAN'}` +
        (aktif ? '' : ` — ${pcHarusDikunci.length} PC harus dikunci: ${pcHarusDikunci.join(', ')}`),
    );
    return { aktif, pcHarusDikunci };
  }

  /** PC mana saja yang sedang dipakai teknisi. */
  async pcDenganSesiAktif(): Promise<string[]> {
    const sesi = await this.semuaSesiAktif();
    return [...new Set(sesi.map((s) => s.pcId))];
  }

}
