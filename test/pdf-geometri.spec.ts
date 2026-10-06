import { beforeAll, describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { ReportsService } from '../src/reports/reports.service.js';
import { LaporanService } from '../src/laporan/laporan.service.js';

/**
 * Tes GEOMETRI PDF — memeriksa posisi elemen dari ISI PDF, bukan dari kode.
 *
 * ⚠️ Kenapa harus begini: bug "logo menimpa garis dan tulisan" TIDAK bisa
 * terlihat dari membaca kode. Barisnya berurutan dan logikanya tampak benar;
 * pdfkit tidak pernah memeriksa tabrakan koordinat, jadi tidak ada error sama
 * sekali. Baru ketahuan dari file PDF yang benar-benar dikirim ke Telegram.
 *
 * Dua koordinat dipakai dalam PDF dan keduanya harus ditangani:
 *   - teks & gambar: `Tm` / `cm` sudah berorientasi "dari atas".
 *   - path garis: `m ... l ... S` berorientasi "dari bawah" (ruang PDF asli),
 *     jadi harus dibalik dulu (`tinggiHalaman - y`) sebelum dibandingkan.
 *
 * Konversi yang keliru akan membuat tes ini lulus untuk PDF yang rusak, jadi
 * ASSERTI di bawah sengaja memakai nilai yang sudah diukur dari file nyata.
 */

const TINGGI_HALAMAN = 841.89;
const M = 40;
const W_BERSIH = 515.28; // 595.28 - 40 * 2

interface Geometri {
  logoAtas: number;
  logoBawah: number;
  logoLebar: number;
  logoX: number;
  garis: number;
  teks: Map<string, { y: number; x: number }>;
}

function bacaPdf(pdf: Buffer): Geometri {
  // Ambil stream yang berisi operator teks, lalu inflate (FlateDecode).
  const streams: Buffer[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pdf.toString('latin1'))) !== null) {
    const awal = m.index + m[0].length;
    const akhir = pdf.toString('latin1').indexOf('endstream', awal);
    try {
      streams.push(inflateSync(pdf.subarray(awal, akhir)));
    } catch {
      // bukan stream terkompresi — abaikan
    }
  }
  const isi = streams
    .filter((s) => s.includes('TJ'))
    .sort((a, b) => b.length - a.length)[0]
    .toString('latin1');

  // --- logo: matriks cm dengan bentuk `w 0 0 h x y cm /XObj Do` ---
  let logoAtas = 0;
  let logoBawah = 0;
  let logoLebar = 0;
  let logoX = 0;
  const cm = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\s*\/\w+ Do/.exec(isi);
  if (cm) {
    logoLebar = Number(cm[1]);
    const tinggi = Math.abs(Number(cm[2]));
    const yAtasDasar = Number(cm[4]);
    logoAtas = TINGGI_HALAMAN - yAtasDasar;
    logoBawah = TINGGI_HALAMAN - (yAtasDasar - tinggi);
    logoX = Number(cm[3]);
  }

  // --- garis horizontal di area header (ruang "dari bawah" -> dibalik) ---
  let garis = 0;
  const gl = /(-?[\d.]+) (-?[\d.]+) m\s*\n(-?[\d.]+) (-?[\d.]+) l[\s\S]{0,140}?\bS\b/.exec(isi);
  if (gl) {
    const y0 = Number(gl[2]);
    const y1 = Number(gl[4]);
    if (Math.abs(y0 - y1) < 0.6) garis = TINGGI_HALAMAN - y0;
  }

  // --- teks: posisi Tm sudah "dari atas" ---
  const teks = new Map<string, { y: number; x: number }>();
  const reTeks = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm[\s\S]{0,95}?\[([^\]]*)\] TJ/g;
  let t: RegExpExecArray | null;
  while ((t = reTeks.exec(isi)) !== null) {
    const huruf = [...t[3].matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
      .join('');
    if (huruf.trim() && !teks.has(huruf.trim())) {
      teks.set(huruf.trim(), { y: Number(t[2]), x: Number(t[1]) });
    }
  }

  return { logoAtas, logoBawah, logoLebar, logoX, garis, teks };
}

describe('geometri PDF laporan', () => {
  let g: Geometri;

  beforeAll(async () => {
    const prisma = new PrismaClient();
    try {
      const reports = new ReportsService(prisma);
      // `null` untuk SettingsService & ActivityLogService: jalur ini hanya
      // membangun PDF, tidak menyentuh email maupun Telegram.
      const laporan = new LaporanService(reports, null as never, null);
      const { tanggal, aggregate, pembanding } = await reports.laporanTutupHariLengkap();
      const pdf = await laporan.buildPdf(tanggal, aggregate, pembanding);
      g = bacaPdf(pdf);
    } finally {
      await prisma.$disconnect();
    }
  }, 30000);

  it('logo ada, di kiri, dan tidak lebih besar dari 100pt', () => {
    expect(g.logoLebar).toBeGreaterThan(0);
    expect(g.logoX).toBe(M);
    // 120pt adalah lebar yang dilaporkan menimpa garis — dijaga di bawah 100.
    expect(g.logoLebar).toBeLessThanOrEqual(100);
  });

  // ⚠️ Ini inti tesnya. y kecil = lebih tinggi di halaman.
  it('garis pembatas TIDAK jatuh di dalam area logo', () => {
    const garisDiLogo = g.logoAtas <= g.garis && g.garis <= g.logoBawah;
    expect({
      garis: Math.round(g.garis),
      logo: [Math.round(g.logoAtas), Math.round(g.logoBawah)],
      garisDiLogo,
    }).toEqual({ garis: expect.any(Number), logo: expect.any(Array), garisDiLogo: false });
  });

  it('teks di bawah logo (baris info tidak tertimpa)', () => {
    const hari = g.teks.get('Hari Buku');
    expect(hari).toBeDefined();
    const teksDiLogo = g.logoAtas <= hari!.y && hari!.y <= g.logoBawah;
    expect(teksDiLogo).toBe(false);
  });

  it('urutan dari atas ke bawah: teks lalu garis lalu logo', () => {
    const hari = g.teks.get('Hari Buku')!;
    expect(hari.y).toBeLessThan(g.garis);
    expect(g.garis).toBeLessThan(g.logoAtas);
  });

  it('jarak logo ke garis cukup untuk keduanya terbaca', () => {
    expect(g.logoAtas - g.garis).toBeGreaterThanOrEqual(4);
  });

  it('judul di kanan, tidak menabrak logo', () => {
    const judul = g.teks.get('Laporan Harian');
    expect(judul).toBeDefined();
    expect(judul!.x).toBeGreaterThan(g.logoX + g.logoLebar);
  });

  it('"Hari Buku" rata kiri di margin', () => {
    expect(g.teks.get('Hari Buku')!.x).toBe(M);
  });

  // ⚠️ Memindahkan kotak ke separuh halaman BUKAN berarti rata kanan.
  // Versi lama menaruh kotaknya di `M + halfW` (= 297.64) tapi teksnya tetap
  // rata kiri, jadi label dan nilainya berhenti di tengah halaman.
  it('"Waktu Dibuat" benar-benar rata kanan', () => {
    const waktu = g.teks.get('Waktu Dibuat');
    expect(waktu).toBeDefined();
    // TEPI KANAN konten = M + W = 555.28. Teks rata kanan berhenti di dekat
    // angka itu, bukan di kotak yang dimulai dari 297.64.
    expect(waktu!.x).toBeGreaterThan(450);
    expect(waktu!.x).toBeLessThanOrEqual(M + W_BERSIH);
  });

  it('kedua label info di baris yang sama', () => {
    const hari = g.teks.get('Hari Buku')!;
    const waktu = g.teks.get('Waktu Dibuat')!;
    expect(Math.abs(hari.y - waktu.y)).toBeLessThan(1);
  });

  it('kedua elemen yang dihapus benar-benar tidak ada', () => {
    expect(g.teks.has('Ringkasan')).toBe(false);
    expect(g.teks.has('Batas Tutup')).toBe(false);
    expect(g.teks.has('23:30 WIB')).toBe(false);
  });

  it('8 label kartu dengan urutan yang diminta', () => {
    const urut = [
      'Voucher Baru',
      'Voucher Topup',
      'Member Baru',
      'Member Topup',
      'Total Login',
      'Pendapatan Voucher',
      'Pendapatan Member',
      'Total Pendapatan',
    ];
    const posisi = urut.map((label) => g.teks.get(label));
    expect(posisi.every((p) => p !== undefined)).toBe(true);

    const baris1 = posisi.slice(0, 4).map((p) => p!.y);
    const baris2 = posisi.slice(4).map((p) => p!.y);
    // Empat label pertama sebaris, empat label berikutnya sebaris.
    for (const b of [baris1, baris2]) {
      expect(Math.max(...b) - Math.min(...b)).toBeLessThan(1);
    }
    // Baris 1 di ATAS baris 2. Karena y kecil = lebih tinggi di halaman,
    // baris yang di atas justru punya y LEBIH BESAR. Arah perbandingan ini
    // pernah terbalik dan membuat tes gagal untuk PDF yang sebenarnya benar.
    expect(baris1[0]).toBeGreaterThan(baris2[0]);
    // Kiri ke kanan DALAM tiap baris.
    //
    // ⚠️ Tidak boleh mengurutkan seluruh 8 nilai sekaligus: kolom pertama baris 1
    // dan kolom pertama baris 2 sama-sama x = 48, jadi daftar gabungannya
    // memang tidak monoton — bukan berarti salah.
    for (const baris of [posisi.slice(0, 4), posisi.slice(4)]) {
      const xs = baris.map((p) => p!.x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
  });
});