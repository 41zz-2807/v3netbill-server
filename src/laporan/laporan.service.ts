import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReportsService,
  DailyReportAggregate,
} from '../reports/reports.service.js';
import { ActivityLogService } from '../activity-log/activity-log.service.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Logo untuk header PDF. Disalin dari `frontend/public/logo-v3netbill.png`
 * ke dalam folder backend supaya ikut ter-mount ke container (mount backend
 * hanya `backend/` → `/app`), sementara `frontend/public` tidak ter-mount
 * ke sana.
 */
// `__dirname` tidak ada di modul ES (package.json memakai "type": "module"),
// jadi path dihitung dari folder kerja aplikasi, yaitu /app di container.
const LOGO_PATH = join(process.cwd(), 'assets', 'logo-v3netbill.png');

const LABEL_JENIS: Record<string, string> = {
  BELI_BARU: 'Beli Baru',
  TOPUP: 'Topup',
  KOREKSI: 'Koreksi',
};

const fmtRp = (n: number): string =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(n);

function fmtWib(d: Date): string {
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).format(d);
}

/** Tanggal saja dalam zona WIB, mis. 27/09/2026. */
function fmtWibTgl(d: Date): string {
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(d);
}

function fmtWibJam(d: Date): string {
  return new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).format(d);
}

/** Perubahan persen dengan tanda, dibulatkan. 3.000 -> 151.500 = "+4950%". */
function persenDari(kini: number, sebelumnya: number): string {
  const persen = Math.round(((kini - sebelumnya) / sebelumnya) * 100);
  return `${persen > 0 ? '+' : ''}${persen}%`;
}

/**
 * Pisahkan daftar penerima menjadi alamat yang sah dan yang ditolak.
 *
 * ⚠️ Pemisahnya menerima koma, titik koma, baris baru, dan spasi. Admin
 * hampir pasti akan menempelkan daftar dengan salah satu dari itu, dan kalau
 * pemisahnya hanya koma maka satu baris seperti
 * "a@x.com b@y.com" akan dianggap satu alamat yang tidak valid — laporan
 * malam itu hilang tanpa sebab yang jelas.
 *
 * ⚠️ Validasi sengaja LONGGAR: syarat minimal ada `@` dan ada titik SESUDAH
 * `@`, tidak lebih dari satu `@`, dan tanpa spasi. Aturan RFC yang ketat
 * (mis. panjang label domain) hanya menolak alamat yang sebenarnya benar —
 * alamat deliveri seperti `user+tag@contoh.co.id` tetap lolos.
 */
export function pisahkanEmail(mentah: string): { sah: string[]; ditolak: string[] } {
  const sah: string[] = [];
  const ditolak: string[] = [];
  const kandidat = mentah.split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const k of kandidat) {
    const at = k.split('@');
    if (at.length === 2 && at[0].length > 0 && at[1].includes('.')) {
      sah.push(k);
    } else {
      ditolak.push(k);
    }
  }
  return { sah, ditolak };
}

export interface KirimHasil {
  tanggal: string;
  filename: string;
  email: { ok: boolean; info?: string; error?: string };
  telegram: { ok: boolean; detail?: string; error?: string };
}

@Injectable()
export class LaporanService {
  private readonly logger = new Logger(LaporanService.name);

  constructor(
    private readonly reportsService: ReportsService,
    private readonly activityLogService: ActivityLogService,
    /**
     * Opsional (`?`) supaya pengujian unit bisa instantiate `LaporanService`
     * tanpa memalsukan seluruh tabel Setting. Kalau tidak ada, daftar
     * penerima hanya bisa datang dari environment — itu perilaku lama, bukan
     * crash, dan helpsnested test tetap bisa jalan.
     */
    private readonly settingsService?: SettingsService,
  ) {}

  @Cron('30 23 * * *', { name: 'tutup-hari-laporan', timeZone: 'Asia/Jakarta' })
  async handleTutupHariOtomatis(): Promise<void> {
    this.logger.log('Cron tutup hari: mulai generate laporan harian...');
    try {
      const hasil = await this.kirimLaporanTutupHari();
      this.logger.log(
        `Laporan tutup hari terkirim: tanggal=${hasil.tanggal}, email=${hasil.email.ok}, telegram=${hasil.telegram.ok}`,
      );
    } catch (err) {
      this.logger.error(`Laporan tutup hari GAGAL: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      try {
        const dihapus = await this.activityLogService.resetDayLogs();
        this.logger.log(`Log aktivitas direset: ${dihapus} baris dihapus`);
      } catch (err) {
        this.logger.error(`Reset log aktivitas GAGAL: ${(err as Error).message}`);
      }
    }
  }

  async kirimLaporanTutupHari(): Promise<KirimHasil> {
    const { tanggal, aggregate, pembanding } = await this.reportsService.laporanTutupHariLengkap();
    const filename = `laporan-tutup-hari-${tanggal}.pdf`;
    const buffer = await this.buildPdf(tanggal, aggregate, pembanding);

    const email = await this.sendEmail(filename, buffer, tanggal, aggregate);
    const telegram = await this.sendTelegram(filename, buffer, tanggal, aggregate);

    return { tanggal, filename, email, telegram };
  }

  /**
   * ⚠️ Parameter `transaksi` sengaja DIHAPUS (4 Okt). Tabel rincian
   * transaksi dihapus karena membuat PDF 79 halaman untuk 27 transaksi, dan
   * angka|natinya sudah ada di kartu Ringkasan. Lihat catatan panjang di
   * bagian "Grafik" di dalam fungsi ini.
   */
  private async buildPdf(
    tanggal: string,
    agg: DailyReportAggregate,
    pembanding: DailyReportAggregate[],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const M = 40;
      const W = doc.page.width - M * 2;
      const pageMaxY = doc.page.height - doc.page.margins.bottom;
      const bold = 'Helvetica-Bold';
      const reg = 'Helvetica';
      const totalPendapatan = agg.pendapatanVoucher + agg.pendapatanMember;

      // Footer DITARIK KE ATAS margin bawah: teks harus di dalam area konten
      // (pdfkit auto-pindah halaman jika y > page.height - margin.bottom).
      //
      // ⚠️ JANGAN pernah memanggil `footer()` lalu menggambar sesuatu dengan
      // posisi relatif terhadap `doc.y`. `doc.text()` di posisi tetap
      // `fy - 2` (dekat dasar halaman) tetap MEMAKAN kursor `doc.y`, jadi
      // setelah footer dipanggil, `doc.y` berada di bawah batas konten.
      // Laporan tutup hari pernah jadi 79 halaman karena itu: setiap baris
      // tabel memicu `addPage()`, lalu footer()+header()+baris digambar di
      // dasar halaman baru, lalu baris berikutnya memicu `addPage()` lagi.
      // Kalau suatu saat butuh multi halaman, panggil `doc.y = M` SESUDAH
      // `footer()`, bukan sesudah `addPage()`.
      const footer = () => {
        const fy = pageMaxY - 12;
        doc
          .moveTo(M, fy - 8)
          .lineTo(M + W, fy - 8)
          .strokeColor('#e2e8f0')
          .lineWidth(0.75)
          .stroke();
        // ⚠️ Nama merk pindah dari header ke footer, sekarang berpasangan
        // dengan domain. Di header hanya ada logo di kiri dan judul di kanan — dua
        // elemen visual sudah cukup, dan teks merek di sana memakan tinggi
        // baris yang tidak perlu.
        doc.font(reg).fontSize(8).fillColor('#94a3b8').text(
          `${process.env.SMTP_FROM_NAME ?? 'Smart Plus'} — smart-plus.id`,
          M,
          fy - 2,
          { width: W, align: 'left' },
        );
        doc.font(reg).fontSize(8).fillColor('#94a3b8').text(
          `Dicetak otomatis oleh v3Netbill — ${fmtWib(new Date())} WIB`,
          M,
          fy - 2,
          { width: W, align: 'right' },
        );
      };

      const fit = (text: string, maxW: number): string => {
        if (doc.widthOfString(text) <= maxW) return text;
        let t = text;
        while (t.length > 0 && doc.widthOfString(t + '…') > maxW) t = t.slice(0, -1);
        return t + '…';
      };

      // ===== Header =====
      // Logo di KIRI, judul di KANAN, satu baris.
      //
      // ⚠️ Tinggi baris header HARUS dihitung dari mana pun yang lebih tinggi
      // antara judul dan logo — BUKAN dari judul saja. Versi sebelumnya memakai
      // `doc.y = headerY + tinggiJudul + 6` padahal logo (tinggi 42pt) jauh
      // lebih tinggi daripada teks 18pt yang hanya ±22pt. Akibatnya garis
      // pembatas dan baris "Hari Buku" digambar DI ATAS logo: pada file yang
      // benar-benar dikirim, logo menutupi y 86-128 sementara "Hari Buku" ada
      // di y 87. Jadi logo dan garisnya bertumpuk.
      //
      // ⚠️ Lebar logo 96pt, bukan 120pt. Kelima alasan:
      //   1. 120pt terlalu besar untuk baris setinggi 22pt.
      //   2. Logo punya wordmark "v3netbill" yang ikut mengecil — 96pt masih
      //      terbaca, 120ptGlyoe Already memakai tinggi halaman yang tidak perlu.
      //   3. Header jadi lebih pendek, dan ruang kosong bawah bertambah —
      //      dipakai untuk memperbesar grafik (lihat catatan tinggi batang).
      // Aspek rasio taken dari berkas asli: 411 x 144.
      const headerY = 44;
      const judul = 'Laporan Harian';
      const LEBAR_LOGO = 96;
      const RASIO_LOGO = 144 / 411;

      doc.font(bold).fontSize(18).fillColor('#0f172a').text(judul, M, headerY, {
        width: W,
        align: 'right',
      });
      const tinggiJudulHeader = doc.y - headerY;

      let tinggiLogo = 0;
      if (existsSync(LOGO_PATH)) {
        tinggiLogo = Math.round(LEBAR_LOGO * RASIO_LOGO);
        // Logo diratakan vertikal terhadap tinggi judul, lalu seluruh tinggi
        // baris diambil dari yang terbesar — itu yang mencegah tumpang tindih.
        const logoTop = headerY + Math.max(0, (tinggiJudulHeader - tinggiLogo) / 2);
        doc.image(LOGO_PATH, M, logoTop, { width: LEBAR_LOGO, height: tinggiLogo });
      }

      const tinggiHeader = Math.max(tinggiJudulHeader, tinggiLogo);
      doc.y = headerY + tinggiHeader + 8;
      doc
        .moveTo(M, doc.y)
        .lineTo(M + W, doc.y)
        .strokeColor('#cbd5e1')
        .lineWidth(1)
        .stroke();
      doc.y += 10;

      // ===== Info: Hari Buku rata kiri, Waktu Dibuat rata KANAN =====
      //
      // ⚠️ "Batas Tutup" DIHAPUS. Nilai 23:30 WIB selalu sama setiap hari,
      // jadi informasi itu bukan informasi — cuma menghabiskan satu kolom
      // lebar penuh. "Hari Buku" tetap di posisi kiri seperti sebelumnya.
      //
      // ⚠️ Kolom kanan harus `align: 'right'`, BUKAN sekadar memindahkan
      // kotaknya ke separuh halaman. Versi sebelumnya menaruh kotak
      // "Waktu Dibuat" di `M + halfW` tapi teksnya tetap rata kiri, jadi
      // label dan nilainya berhenti di tengah halaman — terlihat seperti tidak
      // dipindahkan sama sekali. Rata kanan juga berarti tepi kanannya menyentuh
      // tepi konten (`M + W`), jadi sejajar dengan isi tabel di bawahnya.
      const infoY = doc.y;
      const halfW = W / 2;
      const infoItems: Array<[string, string, number, 'left' | 'right']> = [
        ['Hari Buku', tanggal, M, 'left'],
        ['Waktu Dibuat', `${fmtWib(new Date())} WIB`, M + halfW, 'right'],
      ];
      infoItems.forEach(([k, v, x, align]) => {
        doc
          .font(reg)
          .fontSize(8)
          .fillColor('#64748b')
          .text(k, x, infoY, { width: halfW, align });
        doc.font(bold).fontSize(11).fillColor('#0f172a').text(v, x, infoY + 12, {
          width: halfW,
          align,
        });
      });
      doc.y = infoY + 30;

      // ⚠️ Judul "Ringkasan" DIHAPUS. Delapan kartu sudah berlabel jelas,
      // jadi kata "Ringkasan" hanya menambah tinggi tanpa menambah
      // informasi apa pun.
      const colGap = 10;
      const cardW = (W - colGap * 3) / 4;
      const cardH = 40;
      const cardGapY = 12;
      // ⚠️ Urutan kartu mengikuti urutan baca yang diminta: baris 1 aktivitas
      // akun (voucher lalu member), baris 2 rekap. "Total Pendapatan"
      // sengaja TIDAK di pojok kiri baris 2 — kartu bertebalkan itu
      // penanda total, jadi ia paling kanan sebagai penutup.
      //
      // ⚠️ Indeks kartu = kolom. `col = i % 4`, jadi urutan array ini
      // menentukan posisi secara langsung. Mengubah urutan di sini tanpa
      // mengubah perhitungan kolom hanya akan menggeser isi, bukan barisnya.
      const cards: [string, string, boolean][] = [
        // Baris 1
        ['Voucher Baru', String(agg.voucherTerbentuk), false],
        ['Voucher Topup', String(agg.voucherTopup), false],
        ['Member Baru', String(agg.memberTerbentuk), false],
        ['Member Topup', String(agg.memberTopup), false],
        // Baris 2
        ['Total Login', String(agg.totalLogin), false],
        ['Pendapatan Voucher', fmtRp(agg.pendapatanVoucher), false],
        ['Pendapatan Member', fmtRp(agg.pendapatanMember), false],
        ['Total Pendapatan', fmtRp(totalPendapatan), true],
      ];
      const startY = doc.y;
      cards.forEach(([label, value, prime], i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        const x = M + col * (cardW + colGap);
        const y = startY + row * (cardH + cardGapY);
        doc.roundedRect(x, y, cardW, cardH, 6);
        if (prime) doc.fill('#0f172a');
        else doc.fill('#f1f5f9');
        if (prime) doc.fillColor('#ffffff');
        else doc.fillColor('#0f172a');
        doc.font(bold).fontSize(10).text(value, x + 8, y + 6, {
          width: cardW - 16,
          align: 'left',
        });
        if (prime) doc.fillColor('#cbd5e1');
        else doc.fillColor('#64748b');
        doc.font(reg).fontSize(7).text(label, x + 8, y + 24, {
          width: cardW - 16,
          align: 'left',
        });
      });
      doc.y = startY + 2 * (cardH + cardGapY) + 6;

      // ===== Grafik (menggantikan tabel rincian transaksi) =====
      //
      // ⚠️ PERUBAHAN: tabel "Rincian Transaksi" dihapus. Setiap transaksi
      // jadi satu baris dan tabel dipecah per halaman, jadi hari yang ramai
      // bisa menghasilkan 6-8 halaman — padahal email&Telegram hanya dibaca
      // sekilas. Yang berguna justru angka|natinya, dan itu sudah ada di
      // kartu Ringkasan di atas.
      //
      // Sisa ruang dipakai dua grafik yang digambar manual. pdfkit tidak
      // punya komponen grafik, jadi batang digambar dengan primitive biasa
      // (`rect`), dan skalanya dihitung dari nilai terbesar — supaya dua
      // grafik bisa dibandingkan secara visual.
      const jarakAntarGrafik = 22;
      // ⚠️ Tinggi batang dinaikkan (15 -> 20) untuk mengisi ruang yang
      // tersisa setelah "Ringkasan" dan "Batas Tutup" dihapus dari header.
      //
      // Ini aman untuk syarat "satu halaman" karena yang menjaganya bukan
      // perkiraan tinggi, tapi `MAKS_BARIS_TABEL` di bawah — angka itu yang
      // membatasi bagian yang bisa tumbuh sendiri (tabel). Tinggi grafik
      // tetap konstan, jadi mengubahnya hanya menggeser isi ke atas.
      const tinggiBatang = 20;
      const jarakBaris = 9;
      const judulGrafik = (teks: string, subtitle: string, y: number): number => {
        doc.font(bold).fontSize(13).fillColor('#0f172a').text(teks, M, y, { width: W });
        doc.font(reg).fontSize(8).fillColor('#94a3b8').text(subtitle, M, doc.y, { width: W });
        return doc.y + 2;
      };

      /**
       * Batang datar dari kiri, satu baris per label. Lebar batang relatif
       * terhadap nilai terbesar supaya perbandingannya jujur — kalau semua
       * batang memakai lebar tetap, nilai kecil dan besar terlihat sama saja.
       */
      const batangDatar = (
        y: number,
        data: Array<{ label: string; nilai: number; warna: string }>,
        formatNilai: (n: number) => string,
      ): number => {
        const lebarLabel = 96;
        const lebarNilai = 74;
        const lebarArea = W - lebarLabel - lebarNilai;
        const maks = Math.max(1, ...data.map((d) => Math.abs(d.nilai)));

        data.forEach((d, i) => {
          const yBaris = y + i * (tinggiBatang + jarakBaris);
          doc.font(reg).fontSize(8).fillColor('#334155').text(
            d.label,
            M,
            yBaris + 3.5,
            { width: lebarLabel - 6, align: 'left' },
          );
          // Latar rel panjang penuh, supaya batang pendek tetap
          // terbaca sebagai "ada tapi sedikit" — bukan "tidak ada".
          doc.roundedRect(M + lebarLabel, yBaris, lebarArea, tinggiBatang, 3).fill('#f1f5f9');
          const lebarIsi = Math.max(
            d.nilai > 0 ? 2 : 0,
            (Math.abs(d.nilai) / maks) * lebarArea,
          );
          if (lebarIsi > 0) {
            doc.roundedRect(M + lebarLabel, yBaris, lebarIsi, tinggiBatang, 3).fill(d.warna);
          }
          doc.font(reg).fontSize(8).fillColor('#0f172a').text(
            formatNilai(d.nilai),
            M + lebarLabel + lebarArea + 6,
            yBaris + 3.5,
            { width: lebarNilai - 6, align: 'right' },
          );
        });
        return y + data.length * (tinggiBatang + jarakBaris);
      };

      // -- Grafik 1: pendapatan per sumber --
      //
      // ⚠️ Sisa ruang dihitung DULU, sebelum menggambar apa pun. Kalau tidak,
      // halaman kedua baru ketahuan setelah pdfkit otomatis memecah halaman —
      // dan itu persis yang terjadi: 79 halaman, hampir semuanya kosong.
      // Laporan ini harus selalu satu halaman.
      // ⚠️ Jumlah baris tabel DIBATAS KERAS di sini, bukan di service pemanggil.
      //
      // Ini yang benar-benar membuat laporan ini selalu satu halaman: tinggi
      // tabel = tinggiJudul + (1 + jumlahBaris) * 16, jadi tanpa batas
      // suficientes baris, halaman kedua pasti muncul.
      //
      // Dulu di sini ada "pemadatan" yang dijalankan saat ruang kurang. Dua
      // percobaan membuktikan itu tidak cuma sia-sia, tapi BURUK:
      //   - dipaksa kurang 70pt -> tetap 1 halaman (tidak membuktikan apa pun,
      //     karena ambang lama cuma ambang, bukan ruang nyata);
      //   - dipaksa kurang 630pt -> kode lama 56 halaman, versi "pemadatan"
      //     justru 133 halaman.
      // Alasannya: memadatkan gap hanya hemat sekitar 96pt, sedangkan
      // kekurangannya 630pt. Yang tersisa tetap meluber, dan menggeser
      // koordinat justru menambah pemecahan halaman.
      //
      // Jadi yang dipatahkan adalah sumber pertumbuhannya, bukan gejalanya.
      const MAKS_BARIS_TABEL = 7;
      const barisTabel =
        pembanding.length > MAKS_BARIS_TABEL
          ? pembanding.slice(pembanding.length - MAKS_BARIS_TABEL)
          : pembanding;
      if (barisTabel.length < pembanding.length) {
        this.logger.warn(
          `Tabel perbandingan dipangkas ke ${MAKS_BARIS_TABEL} baris terakhir ` +
            `dari ${pembanding.length} supaya laporan tetap satu halaman.`,
        );
      }

      const tinggiJudul = 26;
      const tinggiTabel = tinggiJudul + (1 + barisTabel.length) * 16;
      let yG = judulGrafik(
        'Pendapatan',
        'Voucher vs Member — semakin seimbang berarti pendapatan tidak bergantung satu sumber',
        doc.y + 14,
      );
      yG = batangDatar(
        yG,
        [
          { label: 'Voucher', nilai: agg.pendapatanVoucher, warna: '#8b5cf6' },
          { label: 'Member', nilai: agg.pendapatanMember, warna: '#10b981' },
        ],
        fmtRp,
      );
      yG += jarakAntarGrafik;

      // -- Grafik 2: komposisi aktivitas akun --
      //
      // ⚠️ Nilai BALIK `batangDatar()` WAJIB disimpan. Versi pertama
      // memanggilnya tanpa `yG = ...`, jadi `yG` masih menunjuk ke ATAS
      // batang "Aktivitas Akun" — dan bagian berikutnya menggambar judulnya
      // di koordinat yang sama. Hasilnya tabel perbandingan menimpa grafik,
      // dan tidak ada error sama sekali karena pdfkit tidak pernah memeriksa
      // tabrakan koordinat.
      yG = judulGrafik('Aktivitas Akun', 'Jumlah voucher dan member yang dibuat vs di-topup', yG);
      yG = batangDatar(
        yG,
        [
          { label: 'Voucher dibuat', nilai: agg.voucherTerbentuk, warna: '#a78bfa' },
          { label: 'Voucher topup', nilai: agg.voucherTopup, warna: '#0ea5e9' },
          { label: 'Member baru', nilai: agg.memberTerbentuk, warna: '#34d399' },
          { label: 'Member topup', nilai: agg.memberTopup, warna: '#0d9488' },
        ],
        (n) => `${n}`,
      );
      yG += jarakAntarGrafik;
      doc.y = yG;

      // -- Tabel perbandingan 5 hari terakhir --
      //
      // ⚠️ Baris hari laporan dicetak TEBAL dan diberi latar, karena itu
      // subjek laporan — 4 hari sebelumnya hanya konteks. Urutannya dari yang
      // paling lama ke hari laporan, jadi urutannya kronologis dan sulit
      // disalahartikan.
      //
      // Kolom "vs kemarin" memakai anak panah + persen, dan sengaja TIDAK
      // memakai warna hijau/merah. Warna merah-hijau untuk naik/turun adalah
      // konvensi pasar, tapi di aplikasi billing naik belum tentu bagus —
      // pendapatan naik karena ada MORE transaksi juga berarti PC menyala lebih
      // lama, dan operator harus membacanya sendiri.
      yG = judulGrafik('Perbandingan 5 Hari Terakhir', 'Hari laporan ditandai tebal', yG);

      const lebarKolom = [W * 0.24, W * 0.14, W * 0.14, W * 0.14, W * 0.22, W * 0.12];
      const tinggiBaris = 16;
      const alignKolom = ['left', 'right', 'right', 'right', 'right', 'right'] as const;

      const tulisBaris = (
        y: number,
        nilai: string[],
        opsi: { tebal?: boolean; latar?: string } = {},
      ) => {
        if (opsi.latar) {
          doc.rect(M, y - 2, W, tinggiBaris).fill(opsi.latar);
        }
        doc.font(opsi.tebal ? bold : reg).fontSize(8);
        let x = M;
        nilai.forEach((sel, i) => {
          const w = lebarKolom[i];
          // ⚠️ JANGAN menggeser x secara manual sekaligus memakai `align`.
          // Berdua-duanya menggeser teks dua kali, jadi kepala kolom tidak
          // lurus dengan angkanya di bawahnya — dan karena versinya sendiri
          // yang salah, tabelnya terlihat "hampir" benar tanpa ada yang
          // protes. Cukup serahkan ke `align` saja.
          doc
            .fillColor(opsi.tebal ? '#0f172a' : '#334155')
            .text(sel, x + 4, y + 3, {
              width: w - 8,
              align: alignKolom[i],
            });
          x += w;
        });
      };

      const totalHari = (a: DailyReportAggregate) => a.pendapatanVoucher + a.pendapatanMember;
      const labelHari = (tgl: string) => {
        const d = new Date(`${tgl}T00:00:00.000Z`);
        return new Intl.DateTimeFormat('id-ID', {
          day: '2-digit',
          month: 'short',
          timeZone: 'UTC',
        }).format(d);
      };

      tulisBaris(yG, ['TANGGAL', 'LOGIN', 'VOUCHER', 'MEMBER', 'PENDAPATAN', 'VS KEMARIN'], {
        tebal: true,
        latar: '#f1f5f9',
      });
      doc
        .moveTo(M, yG + tinggiBaris - 2)
        .lineTo(M + W, yG + tinggiBaris - 2)
        .strokeColor('#e2e8f0')
        .lineWidth(0.5)
        .stroke();
      let yBaris = yG + tinggiBaris;

      // ⚠️ `barisTabel`, bukan `pembanding` — inilah batas kerasnya bekerja.
      barisTabel.forEach((hari, i) => {
        const sebelumnya = i > 0 ? barisTabel[i - 1] : null;
        const total = totalHari(hari);
        const totalSebelum = sebelumnya ? totalHari(sebelumnya) : null;

        let perubahan = '—';
        if (totalSebelum !== null) {
          if (total === 0 && totalSebelum === 0) {
            perubahan = '0%';
          } else if (total === 0) {
            perubahan = '-100%';
          } else if (totalSebelum === 0) {
            // Dari nol ke ada. Persen tidak ada artinya di sini, dan
            // "baru" jauh lebih jujur daripada angka raksasa.
            perubahan = 'baru';
          } else {
            const rasio = total / totalSebelum;
            // ⚠️ Di atas 10x, persen jadi tidak terbaca: naik dari Rp 3.000
            // ke Rp 151.500 menghasilkan "+4950%", yang benar tapi tidak
            // memberi gambaran. Kelipatannya jauh lebih berguna, dan angkanya
            // juga tidak muat di kolom yang sempit ini.
            perubahan =
              rasio >= 10 ? `x${rasio.toFixed(1).replace('.', ',')}` : `${persenDari(total, totalSebelum)}`;
          }
        }

        const adalahHariLaporan = hari.tanggal === tanggal;
        tulisBaris(
          yBaris,
          [
            labelHari(hari.tanggal),
            String(hari.totalLogin),
            `${hari.voucherTerbentuk + hari.voucherTopup}`,
            `${hari.memberTerbentuk + hari.memberTopup}`,
            fmtRp(total),
            perubahan,
          ],
          { tebal: adalahHariLaporan, latar: adalahHariLaporan ? '#e0f7fa' : undefined },
        );
        yBaris += tinggiBaris;
      });

      footer();
      doc.end();
    });
  }

  private async sendEmail(
    filename: string,
    buffer: Buffer,
    tanggal: string,
    agg: DailyReportAggregate,
  ): Promise<{ ok: boolean; info?: string; error?: string }> {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM_EMAIL;

    // ⚠️ Penerima dibaca dari Setting dulu, baru jatuh ke env. Urutannya
    // penting: kalau dibalik, admin yang sudah mengisi daftar di halaman
    // Pengaturan akan "''tidak'" melihat pengaruhnya selama variabel env masih
    // terisi — dan tidak ada pesan apa pun yang menyuruh curigai itu.
    const dariSetting = (await this.settingsService?.get('laporan_email_tujuan')) ?? '';
    const mentah = dariSetting.trim() || (process.env.LAPORAN_EMAIL_TUJUAN ?? '');
    const { sah, ditolak } = pisahkanEmail(mentah);

    if (ditolak.length > 0) {
      // Lewati yang salah, jangan gagalkan seluruh pengiriman. Satu alamat
      // salah ketik tidak boleh berarti laporan malam hilang.
      this.logger.warn(`Alamat email tidak valid, dilewati: ${ditolak.join(', ')}`);
    }

    if (!host || !user || !pass || !from) {
      return { ok: false, error: 'Konfigurasi SMTP belum lengkap' };
    }
    if (sah.length === 0) {
      return {
        ok: false,
        error:
          ditolak.length > 0
            ? `Semua alamat ditolak karena tidak valid: ${ditolak.join(', ')}`
            : 'Belum ada penerima email. Isi di Pengaturan → Data, atau set LAPORAN_EMAIL_TUJUAN.',
      };
    }
    if (ditolak.length > 0) {
      this.logger.warn(
        `Laporan dikirim ke ${sah.length} penerima sah; ${ditolak.length} alamat dilewati.`,
      );
    }

    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: (process.env.SMTP_ENCRYPTION ?? 'tls').toLowerCase() === 'ssl',
      auth: { user, pass },
    });

    const total = agg.pendapatanVoucher + agg.pendapatanMember;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto">
        <h2 style="margin-bottom:4px">Laporan Tutup Hari</h2>
        <p style="color:#64748b;margin-top:0">Hari buku: <b>${tanggal}</b> (tutup 23:30 WIB)</p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <tr><td style="padding:4px 0">Total Login</td><td style="text-align:right"><b>${agg.totalLogin}</b></td></tr>
          <tr><td style="padding:4px 0">Voucher Dibuat / Topup</td><td style="text-align:right"><b>${agg.voucherTerbentuk} / ${agg.voucherTopup}</b></td></tr>
          <tr><td style="padding:4px 0">Member Baru / Topup</td><td style="text-align:right"><b>${agg.memberTerbentuk} / ${agg.memberTopup}</b></td></tr>
          <tr><td style="padding:4px 0">Pendapatan Voucher</td><td style="text-align:right"><b>${fmtRp(agg.pendapatanVoucher)}</b></td></tr>
          <tr><td style="padding:4px 0">Pendapatan Member</td><td style="text-align:right"><b>${fmtRp(agg.pendapatanMember)}</b></td></tr>
          <tr style="border-top:2px solid #0f172a"><td style="padding:4px 0"><b>Total Pendapatan</b></td><td style="text-align:right"><b>${fmtRp(total)}</b></td></tr>
        </table>
        <p style="color:#64748b;font-size:12px">Laporan PDF terlampir. Email ini dikirim otomatis saat tutup hari.</p>
      </div>`;

    // ⚠️ DIKIRIM SATU PER SATU, bukan sekali jalan untuk semua penerima.
    //
    // Alasannya sudah dibuktikan: dengan satu `sendMail()` berisi daftar,
    // server mail membalas `550 all recipients were rejected` begitu SATU
    // alamatnya tidak bisa deliver — jadi satu alamat salah ketik membuat
    // laporan hilang untuk semua penerima, termasuk yang alamatnya benar.
    // Itu kebalikan dari yang diinginkan, dan gejalanya muncul cuma sebagai
    // satu baris error di log tengah malam.
    //
    // Dengan kirim terpisah, alamat yang gagal dilaporkan terpisah dan
    // sisanya tetap sampai.
    const terkirim: string[] = [];
    const gagal: Array<{ alamat: string; alasan: string }> = [];

    for (const alamat of sah) {
      try {
        await transporter.sendMail({
          from: `"${process.env.SMTP_FROM_NAME ?? 'Warnet'}" <${from}>`,
          to: alamat,
          subject: `Laporan Tutup Hari — ${tanggal}`,
          html,
          attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
        });
        terkirim.push(alamat);
      } catch (err) {
        const alasan = (err as Error).message.split('\n')[0];
        gagal.push({ alamat, alasan });
        this.logger.warn(`Email gagal ke ${alamat}: ${alasan}`);
      }
    }

    for (const alamat of ditolak) {
      gagal.push({ alamat, alasan: 'format alamat tidak valid' });
    }

    const rincian =
      `${terkirim.length} dari ${sah.length + ditolak.length} penerima menerima` +
      (gagal.length ? `; gagal: ${gagal.map((g) => g.alamat).join(', ')}` : '');
    this.logger.log(`Laporan email: ${rincian}`);

    if (terkirim.length === 0) {
      return { ok: false, error: `Tidak ada yang menerima. ${rincian}` };
    }
    // `ok: true` walau sebagian gagal, karena laporan benar-benar sampai ke
    // sebagian penerima. Yang dilaporkan sebagai `error` baru kalau TIDAK ADA
    // satu pun yang menerima — dipakai tombol "Kirim Sekarang" untuk
    // membedakan dua keadaan itu.
    return {
      ok: true,
      info: `${rincian}${gagal.length ? ` — ${gagal[0].alasan}` : ''}`,
    };
  }

  private async sendTelegram(
    filename: string,
    buffer: Buffer,
    tanggal: string,
    agg: DailyReportAggregate,
  ): Promise<{ ok: boolean; detail?: string; error?: string }> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return { ok: false, error: 'Konfigurasi Telegram belum lengkap' };
    }

    const total = agg.pendapatanVoucher + agg.pendapatanMember;
    const caption = [
      `📄 Laporan Tutup Hari — ${tanggal}`,
      '',
      `🔑 Login: ${agg.totalLogin}`,
      `🎟 Voucher: ${agg.voucherTerbentuk} baru / ${agg.voucherTopup} topup`,
      `👤 Member: ${agg.memberTerbentuk} baru / ${agg.memberTopup} topup`,
      `💰 Voucher: ${fmtRp(agg.pendapatanVoucher)}`,
      `💰 Member: ${fmtRp(agg.pendapatanMember)}`,
      `🏦 Total: ${fmtRp(total)}`,
    ].join('\n');

    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), filename);
      form.append('caption', caption);

      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
      });
      const json = (await res.json()) as { ok?: boolean; description?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.description ?? `HTTP ${res.status}`);
      }
      return { ok: true, detail: 'terkirim ke chat' };
    } catch (err) {
      this.logger.error(`Telegram gagal: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }
}