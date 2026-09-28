import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReportsService,
  DailyReportAggregate,
  TransaksiLaporan,
} from '../reports/reports.service.js';
import { ActivityLogService } from '../activity-log/activity-log.service.js';

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
    const { tanggal, aggregate, transaksi } = await this.reportsService.laporanTutupHari();
    const filename = `laporan-tutup-hari-${tanggal}.pdf`;
    const buffer = await this.buildPdf(tanggal, aggregate, transaksi);

    const email = await this.sendEmail(filename, buffer, tanggal, aggregate);
    const telegram = await this.sendTelegram(filename, buffer, tanggal, aggregate);

    return { tanggal, filename, email, telegram };
  }

  private async buildPdf(
    tanggal: string,
    agg: DailyReportAggregate,
    transaksi: TransaksiLaporan[],
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
      const contentBottom = pageMaxY - 50;
      const bold = 'Helvetica-Bold';
      const reg = 'Helvetica';
      const totalPendapatan = agg.pendapatanVoucher + agg.pendapatanMember;

      // Footer DITARIK KE ATAS margin bawah: teks harus di dalam area konten
      // (pdfkit auto-pindah halaman jika y > page.height - margin.bottom).
      const footer = () => {
        const fy = pageMaxY - 12;
        doc
          .moveTo(M, fy - 8)
          .lineTo(M + W, fy - 8)
          .strokeColor('#e2e8f0')
          .lineWidth(0.75)
          .stroke();
        doc.font(reg).fontSize(8).fillColor('#94a3b8').text(
          `Dicetak otomatis oleh v3Netbill — ${fmtWib(new Date())} WIB`,
          M,
          fy - 2,
          {
            width: W,
            align: 'center',
          },
        );
      };

      const fit = (text: string, maxW: number): string => {
        if (doc.widthOfString(text) <= maxW) return text;
        let t = text;
        while (t.length > 0 && doc.widthOfString(t + '…') > maxW) t = t.slice(0, -1);
        return t + '…';
      };

      // ===== Header =====
      // Logo memakai berkas PNG asli, jadi warna aslinya ikut terjaga. Lebarnya
      // 150pt: cukup terbaca dari jauh, tapi tidak terlihat lebih besar dari
      // judul laporan sendiri. Kalau berkasnya hilang, PDF tetap dibuat tanpa
      // logo daripada gagal total.
      let headerY = 44;
      if (existsSync(LOGO_PATH)) {
        const logoW = 150;
        const logoH = Math.round((logoW * 144) / 411);
        doc.image(LOGO_PATH, M + (W - logoW) / 2, headerY, { width: logoW, height: logoH });
        headerY += logoH + 10;
      }

      doc.font(bold).fontSize(20).fillColor('#0f172a').text('LAPORAN TUTUP HARI', M, headerY, {
        width: W,
        align: 'center',
      });
      headerY += 26;
      doc
        .font(reg)
        .fontSize(11)
        .fillColor('#64748b')
        .text(process.env.SMTP_FROM_NAME ?? 'Warnet', M, headerY, { width: W, align: 'center' });
      doc.y = headerY + 24;
      doc
        .moveTo(M, doc.y)
        .lineTo(M + W, doc.y)
        .strokeColor('#cbd5e1')
        .lineWidth(1)
        .stroke();
      doc.y += 8;

      // ===== Info baris 3 kolom =====
      const infoItems: [string, string][] = [
        ['Hari Buku', tanggal],
        ['Batas Tutup', '23:30 WIB'],
        ['Waktu Dibuat', fmtWib(new Date())],
      ];
      const infoGap = 12;
      const infoW = (W - infoGap * 2) / 3;
      const infoY = doc.y;
      infoItems.forEach(([k, v], i) => {
        const x = M + i * (infoW + infoGap);
        doc.font(reg).fontSize(8).fillColor('#64748b').text(k, x, infoY);
        doc.font(bold).fontSize(11).fillColor('#0f172a').text(v, x, infoY + 12);
      });
      doc.y = infoY + 32;

      // ===== Ringkasan (gaya web: kartu MiniStat) =====
      doc
        .font(bold)
        .fontSize(13)
        .fillColor('#0f172a')
        .text('Ringkasan', M, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.4);

      const colGap = 10;
      const cardW = (W - colGap * 3) / 4;
      const cardH = 40;
      const cardGapY = 10;
      const cards: [string, string, boolean][] = [
        ['Total Login', String(agg.totalLogin), false],
        ['Total Pendapatan', fmtRp(totalPendapatan), true],
        ['Pendapatan Voucher', fmtRp(agg.pendapatanVoucher), false],
        ['Pendapatan Member', fmtRp(agg.pendapatanMember), false],
        ['Voucher Dibuat', String(agg.voucherTerbentuk), false],
        ['Voucher Topup', String(agg.voucherTopup), false],
        ['Member Baru', String(agg.memberTerbentuk), false],
        ['Member Topup', String(agg.memberTopup), false],
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

      // ===== Rincian Transaksi =====
      if (doc.y > contentBottom) doc.addPage();
      doc.font(bold).fontSize(13).fillColor('#0f172a').text('Rincian Transaksi');
      const headerH = 20;
      const rowH = 17;
      // Urutan kolom: No, Tgl, Kasir, Akun, Jenis, Nominal, Waktu. Waktu
      // dipindah ke kolom paling kanan supaya nilai jam terdorong mentok ke
      // tepi kanan tabel, sementara tanggal tetap dekat dengan nomor.
      // Total lebar kolom tetap sama dengan lebar area konten.
      const widths = [24, 66, 70, 148, 72, 86, 49];
      // Nominal diratakan ke kanan seperti uangnya; Waktu juga ke kanan supaya
      // benar-benar menempel tepi tabel.
      const rightCols = new Set([5, 6]);

      const drawHeader = () => {
        const y = doc.y;
        doc.rect(M, y, W + 0.3, headerH).fill('#1e293b');
        doc.font(bold).fontSize(9);
        let x = M;
        ['No', 'Tgl', 'Kasir', 'Akun', 'Jenis', 'Nominal', 'Waktu'].forEach((h, i) => {
          const right = rightCols.has(i);
          const disp = fit(h, widths[i] - 12);
          const tw = doc.widthOfString(disp);
          const tx = right ? x + widths[i] - 8 - tw : x + 6;
          doc.fillColor('#ffffff').text(disp, tx, y + 6, { width: tw });
          x += widths[i];
        });
        doc.y = y + headerH;
      };

      const drawRow = (cells: string[], y: number, index: number) => {
        doc.rect(M, y, W + 0.3, rowH);
        if (index % 2 === 1) doc.fill('#f8fafc');
        doc.font(reg).fontSize(8.5);
        let x = M;
        cells.forEach((c, i) => {
          const right = rightCols.has(i);
          const disp = fit(c, widths[i] - 12);
          const tw = doc.widthOfString(disp);
          const tx = right ? x + widths[i] - 8 - tw : x + 6;
          doc.fillColor('#0f172a').text(disp, tx, y + 4, { width: tw });
          x += widths[i];
        });
        doc
          .moveTo(M, y + rowH)
          .lineTo(M + W + 0.3, y + rowH)
          .strokeColor('#e2e8f0')
          .lineWidth(0.5)
          .stroke();
      };

      doc.moveDown(0.4);
      drawHeader();
      let no = 1;
      let sumNominal = 0;
      transaksi.forEach((t, i) => {
        if (doc.y + rowH > contentBottom) {
          doc.addPage();
          footer();
          drawHeader();
        }
        const rowY = doc.y;
        sumNominal += t.nominal;
        drawRow(
          [
            String(no++),
            fmtWibTgl(t.waktu),
            t.kasir,
            t.akun,
            LABEL_JENIS[t.jenis] ?? t.jenis,
            fmtRp(t.nominal),
            fmtWibJam(t.waktu),
          ],
          rowY,
          i,
        );
        doc.y = rowY + rowH;
      });

      // ===== Baris total =====
      if (doc.y + rowH > contentBottom) {
        doc.addPage();
        footer();
      }
      const totalY = doc.y;
      doc.rect(M, totalY, W + 0.3, rowH).fill('#e2e8f0');
      doc.font(bold).fontSize(9);
      const totalRp = fmtRp(sumNominal);
      // TOTAL diratakan ke tepi kanan kolom Jenis, dan angkanya ke tepi kanan
      // kolom Nominal, jadi keduanya benar-benar sejajar dengan judulnya.
      const xJenis = M + widths[0] + widths[1] + widths[2] + widths[3];
      const xNominal = xJenis + widths[4];
      const totalLabelW = doc.widthOfString('TOTAL');
      doc
        .fillColor('#0f172a')
        .text('TOTAL', xJenis + widths[4] - 8 - totalLabelW, totalY + 4, {
          width: totalLabelW,
        });
      const totalRpW = doc.widthOfString(totalRp);
      doc.text(totalRp, xNominal + widths[5] - 8 - totalRpW, totalY + 4, {
        width: totalRpW,
      });
      doc.y = totalY + rowH;

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
    const tujuan = process.env.LAPORAN_EMAIL_TUJUAN;

    if (!host || !user || !pass || !from || !tujuan) {
      return { ok: false, error: 'Konfigurasi SMTP/tujuan belum lengkap' };
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

    try {
      const info = await transporter.sendMail({
        from: `"${process.env.SMTP_FROM_NAME ?? 'Warnet'}" <${from}>`,
        to: tujuan
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .join(', '),
        subject: `Laporan Tutup Hari — ${tanggal}`,
        html,
        attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
      });
      return { ok: true, info: info.messageId };
    } catch (err) {
      this.logger.error(`Email gagal: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
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