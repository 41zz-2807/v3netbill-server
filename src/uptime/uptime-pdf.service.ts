import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { UptimeQueryService, UptimeRingkasan } from './uptime-query.service.js';

/**
 * Laporan uptime PC dalam PDF.
 *
 * ⚠️ Berbeda dari PDF tutup hari (`laporan.service.ts`) yang dikirim lewat
 * email, yang ini diunduh kasir dari halaman Laporan. Jadi isinya harus
 * apa yang operator ketika itu sedang lihat di layar — termasuk
 * rentang tanggal yang dipilih di form.
 *
 * Format uang dipakai helper yang sama dengan halaman web (bulat, pemisah
 * ribuan gaya Indonesia) supaya angka di PDF dan di layar identik. Kalau dua
 * tempat memakai pembulatan berbeda, kasir akan menanyakan mana yang benar.
 */
@Injectable()
export class UptimePdfService {
  private readonly logger = new Logger(UptimePdfService.name);

  constructor(private readonly uptime: UptimeQueryService) {}

  async build(ringkasan: UptimeRingkasan): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        this.gambar(doc, ringkasan);
        doc.end();
      } catch (e) {
        // ⚠️ `doc.end()` WAJIB dipanggil juga saat gagal. pdfkit menahan
        // stream sampai di-end(), jadi tanpa itu promise-nya tidak pernah
        // selesai — request menggantung, bukan 500.
        this.logger.error(`Gagal membuat PDF uptime: ${(e as Error).message}`);
        doc.end();
        reject(e);
      }
    });
  }

  private gambar(doc: PDFKit.PDFDocument, r: UptimeRingkasan): void {
    const bold = 'Helvetica-Bold';
    const reg = 'Helvetica';
    const M = 40;
    const W = doc.page.width - M * 2;
    const l = r.listrik;

    // ⚠️ SETIAP y DILACAK SENDIRI, tidak pernah memakai `doc.y`.
    //
    // `doc.y` pdfkit tidak bisa dipercaya setelah `text()` yang memakai
    // opsi `width`: pada versi ini kursorReturned ke posisi yang jauh di bawah
    // teks yang baru saja digambar, dan hasilnya bukan hanya meleset satu baris — seluruh kotak baris tabel berakhir ~500pt di bawah teksnya.
    // PDF tetap "berhasil" dibuat dan halaman tetap cuma 1, jadi tidak ada
    // error apa pun yang menunjukkan.
    let y = M;

    doc.font(bold).fontSize(16).fillColor('#0f172a').text('Laporan Uptime PC', M, y);
    y += 22;

    doc
      .font(reg)
      .fontSize(10)
      .fillColor('#475569')
      .text(
        `Periode ${formatTanggalPendek(r.dari)} - ${formatTanggalPendek(r.sampai)}  |  ${r.tanggal.length} hari  |  ${r.pcs.length} PC`,
        M,
        y,
        { width: W },
      );
    y += 13;

    doc
      .font(reg)
      .fontSize(9)
      .fillColor('#64748b')
      .text(
        'Dihitung dari heartbeat agent yang dicatat tiap 60 detik. Angka biaya listrik adalah estimasi, bukan hasil pengukuran meter.',
        M,
        y,
        { width: W },
      );
    y += 16;

    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor('#cbd5e1').stroke();
    y += 12;

    // ── Ringkasan listrik ────────────────────────────────────────────────
    const kartu: [string, string][] = [
      ['Total energi', `${formatKwh(l.totalKwh, 2)} kWh`],
      ['Estimasi biaya', rupiah(l.totalRupiah)],
      ['Tarif per kWh', l.tarifPerKwh.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
      ['Total daya', `${l.totalWatt.toLocaleString('id-ID')} W`],
      ['Total nyala', formatDurasi(l.totalDetik)],
    ];
    const lebarKartu = W / kartu.length;
    // ⚠️ Tiap kartu HARUS geser ke kanan ~lebarKartu. Kalau semua pakai x yang
    // sama, lima label dan lima nilai menumpuk jadi satu tumpukan teks di
    // pojok kiri, dan kasir tidak bisa membaca satu pun angkanya.
    for (const [i, [label, nilai]] of kartu.entries()) {
      const xk = M + i * lebarKartu;
      doc.font(reg).fontSize(8).fillColor('#64748b').text(label, xk, y, { width: lebarKartu });
      doc.font(bold).fontSize(12).fillColor('#0f172a').text(nilai, xk, y + 11, { width: lebarKartu });
    }
    y += 32;

    // ── Tabel per PC ────────────────────────────────────────────────────
    const kolom = [
      { judul: 'PC', lebar: 90, align: 'left' as const },
      { judul: 'Watt', lebar: 55, align: 'right' as const },
      { judul: 'Menit', lebar: 70, align: 'right' as const },
      { judul: 'Jam', lebar: 60, align: 'right' as const },
      { judul: 'kWh', lebar: 75, align: 'right' as const },
      { judul: 'Biaya', lebar: 165, align: 'right' as const },
    ];
    // ⚠️ Lebar kolom HARUS dijumlahkan dengan lebar halaman. Kalau melebihi,
    // pdfkit tidak memberi peringatan — dia hanya menjadwalkannya melebar, teks keluar
    // tepi kanan, dan terpotong diam-diam.
    const totalLebar = kolom.reduce((n, k) => n + k.lebar, 0);
    if (totalLebar > W) {
      const skala = W / totalLebar;
      for (const k of kolom) k.lebar = Math.floor(k.lebar * skala);
    }

    y = tulisBaris(doc, kolom.map((k) => k.judul), kolom, y, bold, '#e2e8f0', '#334155');
    for (const pc of [...r.pcs].sort((a, b) => b.detik - a.detik)) {
      y = tulisBaris(
        doc,
        [
          pc.namaPc,
          String(pc.watt),
          String(Math.round(pc.detik / 60)),
          (pc.detik / 3600).toFixed(1),
          formatKwh(pc.kwh, 3),
          rupiah(pc.rupiah),
        ],
        kolom,
        y,
        reg,
        '#ffffff',
        '#0f172a',
      );
      if (y > doc.page.height - 140) {
        doc.addPage();
        y = M;
      }
    }
    y = tulisBaris(
      doc,
      [
        'TOTAL',
        String(l.totalWatt),
        String(Math.round(l.totalDetik / 60)),
        (l.totalDetik / 3600).toFixed(1),
        formatKwh(l.totalKwh, 2),
        rupiah(l.totalRupiah),
      ],
      kolom,
      y,
      bold,
      '#f1f5f9',
      '#0f172a',
    );

    // ── Grafik HARIAN per PC (garis) — persis seperti di web ─────────────
    y += 22;
    if (y + 170 > doc.page.height - 70) {
      doc.addPage();
      y = M;
    }
    doc.font(bold).fontSize(12).fillColor('#0f172a').text('Uptime harian per PC (menit)', M, y);
    y += 18;
    gambarGarisHarian(doc, M, y, W, 120, r);
    y += 120 + 26;

    // ── Grafik batang per PC (total rentang) — persis seperti di web ─────
    if (y + 170 > doc.page.height - 70) {
      doc.addPage();
      y = M;
    }
    doc.font(bold).fontSize(12).fillColor('#0f172a').text('Total uptime per PC (menit)', M, y);
    y += 18;
    gambarBatang(
      doc,
      M,
      y,
      W,
      110,
      [...r.pcs]
        .sort((a, b) => b.detik - a.detik)
        .map((pc) => ({ label: pc.namaPc, nilai: Math.round(pc.detik / 60) })),
    );
    y += 110 + 4;

    // Footer memakai koordinat absolut di halaman TERAKHIR, dan digambar
    // paling akhir. Kalau digambar di tengah, `addPage()` di atas membuatnya
    // menempel ke halaman yang salah.
    doc
      .font(reg)
      .fontSize(8)
      .fillColor('#94a3b8')
      .text(
        `Dicetak ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB  |  v3netbill`,
        M,
        doc.page.height - 48,
        { width: W, align: 'center' },
      );
  }
}



/**
 * Tulis satu baris tabel dan kembalikan koordinat y baris berikutnya.
 *
 * ⚠️ Fungsi ini TIDAK memakai `doc.text` tanpa posisi, karena pdfkit memindahkan
 * kursor ke baris terakhir — itu yang membuat dua bagian PDF pernah saling
 * menimpa. Semua koordinat dihitung manual dari `y` yang dikembalikan.
 */
function tulisBaris(
  doc: PDFKit.PDFDocument,
  nilai: string[],
  kolom: { judul: string; lebar: number; align: 'left' | 'right' }[],
  y: number,
  font: string,
  warnaLatar: string,
  warnaTeks: string,
): number {
  const tinggi = 18;
  const M = 40;
  doc.rect(M, y, kolom.reduce((n, k) => n + k.lebar, 0), tinggi).fill(warnaLatar);
  let x = M;
  for (let i = 0; i < kolom.length; i++) {
    const k = kolom[i];
    doc
      .font(font)
      .fontSize(9)
      .fillColor(warnaTeks)
      .text(nilai[i] ?? '', x, y + 5, { width: k.lebar - 8, align: k.align });
    x += k.lebar;
  }
  return y + tinggi;
}

/** Batang relatif terhadap nilai terbesar, supaya perbandingannya jujur. */
function gambarBatang(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  tinggi: number,
  data: { label: string; nilai: number }[],
): number {
  if (data.length === 0) return y;
  const maks = Math.max(...data.map((d) => d.nilai), 1);
  const lebarSlot = w / data.length;
  const lebarBatang = Math.max(2, Math.min(28, lebarSlot * 0.6));
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const tinggiBatang = Math.max(1, (d.nilai / maks) * (tinggi - 22));
    const bx = x + i * lebarSlot + (lebarSlot - lebarBatang) / 2;
    // ⚠️ Warna batang ikut palet halaman web (WARNA_UPTIME = #0ea5e9), supaya
    // grafik di PDF tidak terlihat seperti diagram yang dibuat orang lain.
    doc.rect(bx, y + tinggi - tinggiBatang, lebarBatang, tinggiBatang).fill('#0ea5e9');
    doc
      .font('Helvetica')
      .fontSize(6)
      .fillColor('#64748b')
      .text(d.label, x + i * lebarSlot, y + tinggi - 10, { width: lebarSlot, align: 'center' });
  }
  return y + tinggi + 4;
}

/**
 * Grafik HARIAN per PC — satu garis per PC, persis `LineChart` di halaman web.
 *
 * ⚠️ Semua koordinat pdfkit (text, rect, moveTo/lineTo) dibaca
 * dari kiri atas dengan y bertambah ke bawah.
 *
 * Sumbu X = tanggal dalam rentang. Kalau rentangnya satu hari, satu titik —
 * itupun masih benar, karena titik itu bisa dilihat dari legenda PC-nya.
 */
function gambarGarisHarian(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  tinggi: number,
  r: UptimeRingkasan,
): void {
  const tanggal = r.tanggal;
  if (tanggal.length === 0 || r.pcs.length === 0) return;

  // Nilai maks untuk skala Y. 0 tidak boleh jadi pembagi: grafik PC warnet
  // berisi nol pada hari pertama, dan `nilai/0` jadi NaN yang akan menggambar
  // garis keluar halaman tanpa error.
  const nilaiPerPcPerHari = r.pcs.map((pc) =>
    tanggal.map((t) => (pc.perHari.find((h) => h.tanggal === t)?.detik ?? 0) / 60),
  );
  let maks = 1;
  for (const deret of nilaiPerPcPerHari) for (const v of deret) maks = Math.max(maks, v);

  const padL = 34; // ruang label sumbu Y
  const padR = 6;
  const plotW = w - padL - padR;
  const plotH = tinggi - 16;
  const slotX = tanggal.length > 1 ? plotW / (tanggal.length - 1) : 0;
  const posisiX = (i: number) => x + padL + (tanggal.length > 1 ? i * slotX : slotX / 2);
  const posisiY = (v: number) => y + (plotH - (v / maks) * plotH);

  // Grid + label sumbu Y (0, setengah, maks)
  for (const [frac, label] of [[0, '0'], [0.5, formatMenitSumbu(maks / 2)], [1, formatMenitSumbu(maks)]] as [number, string][]) {
    const yy = y + plotH - frac * plotH;
    doc.moveTo(x + padL, yy).lineTo(x + w - padR, yy)
      .lineWidth(0.5).strokeColor('#e2e8f0').stroke();
    doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
      .text(label, x, yy - 4, { width: padL - 4, align: 'right' });
  }
  // Garis sumbu X
  doc.moveTo(x + padL, y + plotH).lineTo(x + w - padR, y + plotH)
    .lineWidth(1).strokeColor('#cbd5e1').stroke();

  // Label sumbu X — dipadatkan kalau terlalu rapat, supaya tidak tumpang.
  const maksLabel = Math.max(1, Math.floor(plotW / 42));
  for (let i = 0; i < tanggal.length; i += Math.max(1, Math.ceil(tanggal.length / maksLabel))) {
    doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
      .text(tanggal[i].slice(5), posisiX(i) - 21, y + plotH + 3, { width: 42, align: 'center' });
  }

  // Satu garis per PC, warna sesuai legenda.
  const WARNA = ['#0ea5e9', '#f97316', '#22c55e', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899', '#3b82f6', '#84cc16'];
  r.pcs.forEach((pc, pi) => {
    const deret = nilaiPerPcPerHari[pi];
    for (let i = 0; i < deret.length - 1; i++) {
      doc.moveTo(posisiX(i), posisiY(deret[i]))
        .lineTo(posisiX(i + 1), posisiY(deret[i + 1]))
        .lineWidth(1.6).strokeColor(WARNA[pi % WARNA.length]).stroke();
    }
    for (let i = 0; i < deret.length; i++) {
      doc.circle(posisiX(i), posisiY(deret[i]), 1.8).fill(WARNA[pi % WARNA.length]);
    }
  });

  // Legenda — satu baris, dibungkus kalau tidak muat.
  let lx = x + padL;
  const ly = y + plotH + 14;
  r.pcs.forEach((pc, pi) => {
    doc.moveTo(lx, ly + 4).lineTo(lx + 14, ly + 4)
      .lineWidth(2.4).strokeColor(WARNA[pi % WARNA.length]).stroke();
    doc.font('Helvetica').fontSize(7);
    const lebar = doc.widthOfString(pc.namaPc) + 20;
    doc.font('Helvetica').fontSize(7).fillColor('#475569').text(pc.namaPc, lx + 16, ly, { width: lebar });
    lx += 16 + lebar + 8;
    if (lx > x + w - 40) lx = x + padL; // bungkus ke baris berikutnya jika penuh
  });
}

/** Label sumbu Y — nilai menit jadi ringkas (mis. 90 -> "90", 120 -> "120"). */
function formatMenitSumbu(menit: number): string {
  return String(Math.round(menit));
}

/** Rupiah bulat — sama dengan `formatRupiahBulat()` di halaman web. */
function rupiah(n: number): string {
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
}

function formatKwh(n: number, desimal: number): string {
  return n.toLocaleString('id-ID', {
    minimumFractionDigits: desimal,
    maximumFractionDigits: desimal,
  });
}

function formatDurasi(detik: number): string {
  const total = Math.max(0, Math.floor(detik));
  const jam = Math.floor(total / 3600);
  const menit = Math.floor((total % 3600) / 60);
  return jam > 0 ? `${jam}j ${menit}m` : `${menit}m`;
}

/** "2026-10-06" -> "06 Okt 2026". Month Indonesian, tanpa dependensi intl. */
export function formatTanggalPendek(tanggal: string): string {
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tanggal);
  if (!m) return tanggal;
  return `${m[3]} ${bulan[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}
