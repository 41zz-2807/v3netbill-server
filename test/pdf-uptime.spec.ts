import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { formatTanggalPendek } from '../src/uptime/uptime-pdf.service.js';
import type { UptimeRingkasan } from '../src/uptime/uptime-query.service.js';

/**
 * Geometri PDF laporan uptime.
 *
 * ⚠️ Tes ini membaca ISI PDF hasil build, bukan memanggil fungsi internal.
 * Jadi yang diperiksa benar yang keluar dari `build()`.
 *
 * ⚠️ Dua koordinat dalam PDF tidak satu satuan, dan mencampur keduanya
 * tidak merusak apa pun:
 *
 * | Elemen                   | y dihitung dari |
 * |--------------------------|-----------------|
 * | Teks (`Tm`)              | ATAS            |
 * | Kotak & garis (`re`, `m`, `l`) | BAWAH  |
 *
 * Karena itu keduanya harus dibalik sebelum dibandingkan: `841.89 - y`
 * untuk yang dari bawah. Versi pertama dari PDF ini memakai y dari atas untuk
 * `doc.rect()`, sehingga setiap kotak baris tabel muncul ~500pt di bawah
 * teksnya. Tidak ada error, halaman tetap 1, PDF tetap "berhasil".
 */
const HAL = 841.89;

async function ambilPdf(dari: string, sampai: string, pcs: number): Promise<{ isi: string; kasar: string }> {
  const { UptimePdfService } = await import('../src/uptime/uptime-pdf.service.js');
  const { UptimeQueryService } = await import('../src/uptime/uptime-query.service.js');

  const tanggal: string[] = [];
  for (let t = Date.parse(`${dari}T00:00:00Z`); t <= Date.parse(`${sampai}T00:00:00Z`); t += 86_400_000) {
    tanggal.push(new Date(t).toISOString().slice(0, 10));
  }

  const ringkasan: UptimeRingkasan = {
    dari,
    sampai,
    tanggal,
    listrik: { tarifPerKwh: 1444.7, totalDetik: 46_708, totalKwh: 1.947, totalRupiah: 2812, totalWatt: 750 },
    pcs: Array.from({ length: pcs }, (_, i) => ({
      id: `pc-${i}`,
      namaPc: `PC00${i + 1}`,
      detik: 1000 * (i + 1),
      watt: 150,
      kwh: 0.04 * (i + 1),
      rupiah: 70 * (i + 1),
      perHari: tanggal.map((t) => ({ tanggal: t, detik: 500 })),
    })),
  };

  // Polanya: PdfService hanya butuh objek dengan `ringkasan()`.
  const svc = new UptimePdfService({ ringkasan: async () => ringkasan } as never);
  const buffer = await svc.build(ringkasan);
  // ⚠️ Isi PDF terkompresi (FlateDecode). Tanpa inflate, tidak ada satu pun
  // teks atau koordinat yang bisa dibaca — dan tesnya akan "lulus" sambil
  // memeriksa file kosong. Itu sebabnya `teks` di bawah dicek tidak kosong.
  const kasar = buffer.toString('latin1');
  const chunks: string[] = [];
  for (const m of kasar.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      chunks.push(inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      // Stream yang bukan Flate (mis. font) dilewati.
    }
  }
  return { isi: chunks.join('\n'), kasar };
}

type Box = { yAtas: number; yBawah: number; x: number; w: number; h: number };
type Posisi = { yAtas: number; x: number; teks: string };

function urai(pdf: string): { teks: Posisi[]; kotak: Box[]; garis: number[] } {
  const teks: Posisi[] = [];
  const kotak: Box[] = [];
  const garis: number[] = [];

  for (const m of pdf.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*\n\/F\d+ [\d.]+ Tf\s*\n\[(.*?)\]\s*TJ/g)) {
    const isi = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
      .join('');
    if (!isi.trim()) continue;
    teks.push({ x: Number(m[1]), yAtas: HAL - Number(m[2]), teks: isi });
  }

  // `re` diikuti operasi warna lalu `f` — tidak selalu persis di baris berikutnya.
  for (const m of pdf.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re\n?([\s\S]{0,200}?)f\n/g)) {
    const x = Number(m[1]);
    const yBawah = Number(m[2]);
    const w = Number(m[3]);
    const h = Number(m[4]);
    if (h < 4) continue; // batang 1px untuk hari tanpa data diabaikan
    kotak.push({ x, yBawah, w, h, yAtas: HAL - (yBawah + h) });
  }
  for (const m of pdf.matchAll(/([\d.-]+) ([\d.-]+) m\n([\d.-]+) ([\d.-]+) l/g)) {
    garis.push(HAL - Number(m[2]));
  }
  return { teks, kotak, garis };
}

describe('PDF laporan uptime', () => {
  it('berkas benar-benar PDF dan punya isi', async () => {
    const { isi, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    expect(kasar.startsWith('%PDF-')).toBe(true);
    expect(kasar.length).toBeGreaterThan(1500);
    expect(kasar).toContain('%%EOF');
    // Isi yang ter-inflate WAJIB tidak kosong — kalau regex tidak cocok,
    // `teks` kosong dan seluruh tes geometri "lolos" tanpa memeriksa apa pun.
    expect(isi.length).toBeGreaterThan(500);
    expect(urai(isi).teks.length).toBeGreaterThan(10);
  });

  it('judul, periode, dan tarif muncul sebagai teks', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    const { teks } = urai(pdf);
    const semua = teks.map((t) => t.teks).join(' ');
    expect(semua).toContain('Laporan Uptime PC');
    expect(semua).toContain('01 Okt 2026');
    expect(semua).toContain('06 Okt 2026');
    expect(semua).toContain('1.444,70');
    expect(semua).toContain('Rp 2.812');
  });

  it('🔴 setiap kotak baris tabel MEMILIKI teks di dalamnya', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    const { teks, kotak } = urai(pdf);
    // Baris tabel punya tinggi 18. Ambil kotak setebal itu saja.
    const baris = kotak.filter((k) => Math.abs(k.h - 18) < 1);
    expect(baris.length).toBeGreaterThanOrEqual(7); // header + 5 PC + TOTAL

    const tanpaTeks = baris.filter(
      (k) =>
        !teks.some(
          (t) =>
            t.x >= k.x - 2 &&
            t.x <= k.x + k.w + 2 &&
            t.yAtas >= k.yAtas - 2 &&
            t.yAtas <= k.yAtas + k.h + 2,
        ),
    );
    // Kotak tabel selalu punya minimal kolom PC + Watt + Menit + Jam + kWh + Biaya.
    expect(tanpaTeks.length).toBe(0);
  });

  it('🔴 kotak tabel tidak jauh di bawah teksnya (regresi bug koordinat)', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    const { teks, kotak } = urai(pdf);
    const baris = kotak.filter((k) => Math.abs(k.h - 18) < 1);
    // ⚠️ Yang dibandingkan OFFSET, bukan rentang. Mengukur rentang (kotak
    // terakhir - teks pertama) selalu besar karena tabel memang punya
    // banyak baris — tes itu akan selalu benar walau kotakNY yang salah.
    const header = teks.find((t) => t.teks.trim() === 'PC')!;
    const total = teks.find((t) => t.teks.trim() === 'TOTAL')!;
    const barisUrut = [...baris].sort((a, b) => a.yAtas - b.yAtas);

    // Tanpa pembalikan, selisihnya ~500pt.
    expect(Math.abs(barisUrut[0].yAtas - header.yAtas)).toBeLessThan(20);
    const kotakTotal = barisUrut[barisUrut.length - 1];
    expect(Math.abs(kotakTotal.yAtas - total.yAtas)).toBeLessThan(20);
  });

  it('garis pemisah ada dan berada DI BAWAH subjudul, bukan di dasar halaman', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    const { teks, garis } = urai(pdf);
    expect(garis.length).toBe(1);
    const subjudul = teks.find((t) => t.teks.includes('Dihitung dari heartbeat'));
    expect(subjudul).toBeDefined();
    // ⚠️ Tanpa pembalikan, garis ada di y ~750 (dasar halaman).
    expect(garis[0]).toBeGreaterThan(subjudul!.yAtas);
    expect(garis[0]).toBeLessThan(subjudul!.yAtas + 60);
  });

  it('judul paling atas, lalu periode, lalu catatan — tidak saling menimpa', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    const { teks } = urai(pdf);
    const judul = teks.find((t) => t.teks.includes('Laporan Uptime'))!;
    const periode = teks.find((t) => t.teks.includes('Periode'))!;
    const catatan = teks.find((t) => t.teks.includes('Dihitung dari'))!;
    expect(judul.yAtas).toBeLessThan(periode.yAtas);
    expect(periode.yAtas).toBeLessThan(catatan.yAtas);
  });

  it('semua teks berada di dalam halaman', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    const { teks } = urai(pdf);
    for (const t of teks) {
      expect(t.yAtas).toBeGreaterThanOrEqual(0);
      expect(t.yAtas).toBeLessThan(HAL);
      expect(t.x).toBeLessThan(596); // A4 lebar 595,28
    }
  });

  it('banyak PC = 5 baris tabel + header + TOTAL', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-10-01', '2026-10-06', 5);
    const { kotak } = urai(pdf);
    const baris = kotak.filter((k) => Math.abs(k.h - 18) < 1);
    expect(baris.length).toBe(7);
  });

  it('24 hari tetap muat dan tidak menumpuk isi', async () => {
    const { isi: pdf, kasar } = await ambilPdf('2026-09-13', '2026-10-06', 6);
    const { teks, kotak } = urai(pdf);
    const baris = kotak.filter((k) => Math.abs(k.h - 18) < 1);
    // 1 header + 6 PC + 1 TOTAL = 8 baris, semuanya harus punya teks
    expect(baris.length).toBe(8);
    const yUnik = new Set(baris.map((k) => Math.round(k.yAtas)));
    expect(yUnik.size).toBe(baris.length); // tidak ada baris menumpuk
    expect(teks.length).toBeGreaterThan(20);
  });
});

describe('formatTanggalPendek', () => {
  it('format Indonesia dengan nama bulan', () => {
    expect(formatTanggalPendek('2026-10-06')).toBe('06 Okt 2026');
    expect(formatTanggalPendek('2026-01-01')).toBe('01 Jan 2026');
    expect(formatTanggalPendek('2026-12-31')).toBe('31 Des 2026');
  });

  it('input tidak sah dikembalikan apa adanya, tidak exception', () => {
    expect(formatTanggalPendek('bukan tanggal')).toBe('bukan tanggal');
    expect(formatTanggalPendek('')).toBe('');
  });
});
