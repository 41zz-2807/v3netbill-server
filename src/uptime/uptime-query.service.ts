import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { tanggalWib } from '../common/wib-date.js';
import { hitungKwh, hitungRupiah, tarifDariSetting, wattDariPc } from './listrik.js';

export interface UptimePerHari {
  tanggal: string;
  detik: number;
}

export interface UptimePc {
  id: string;
  namaPc: string;
  /** Total heartbeat yang diterima dalam rentang yang diminta, dalam detik. */
  detik: number;
  /** Daya PC dalam watt — sumber angka kWh di bawah. */
  watt: number;
  /** Estimasi energi listrik untuk PC ini dalam rentang, dalam kWh. */
  kwh: number;
  /** Estimasi biaya listrik dalam rupiah (kWh x tarif). */
  rupiah: number;
  perHari: UptimePerHari[];
}

export interface RingkasanListrik {
  /** Tarif per kWh yang dipakai, dibaca dari `Setting.harga_per_kwh`. */
  tarifPerKwh: number;
  totalDetik: number;
  totalKwh: number;
  totalRupiah: number;
  /** Total watt PC yang ikut dihitung — deninator untuk kWh rata-rata. */
  totalWatt: number;
}

export interface UptimeRingkasan {
  dari: string;
  sampai: string;
  /** Daftar tanggal dalam rentang, termasuk yang nol — supaya grafik tidak
   *  hopping Restricted: hari tanpa data tetap punya titik di sumbu X. */
  tanggal: string[];
  pcs: UptimePc[];
  listrik: RingkasanListrik;
}

const MAKS_HARI = 366;

@Injectable()
export class UptimeQueryService {
  constructor(private prisma: PrismaService) {}

  async ringkasan(dari: string, sampai: string): Promise<UptimeRingkasan> {
    const awal = parseTanggal(dari);
    const akhir = parseTanggal(sampai);
    if (akhir < awal) {
      throw new Error('Tanggal "sampai" harus lebih besar atau sama dengan "dari"');
    }
    const jumlahHari = Math.floor((akhir.getTime() - awal.getTime()) / 86_400_000) + 1;
    if (jumlahHari > MAKS_HARI) {
      throw new Error(`Rentang maksimal ${MAKS_HARI} hari`);
    }

    // ⚠️ Hanya PC `rusak = false`. PC yang ditandai rusak tidak muncul di
    // halaman mana pun, jadi uptime-nya juga tidak — konsisten dengan
    // dashboard, halaman login, dan aplikasi mobile.
    const pcs = await this.prisma.pc.findMany({
      where: { rusak: false },
      select: { id: true, namaPc: true, watt: true },
      orderBy: { namaPc: 'asc' },
    });

    // ⚠️ Tarif dibaca dari `Setting` TIAP permintaan, bukan di-cache, supaya
    // admin bisa memperbaruinya dan angka di laporan langsung benar pada
    // render berikutnya. Tarif ditinjau tiap kuartal, jadi cache di sini bisa
    // bertahan berbulan-bulan menampilkan biaya yang salah.
    const tarifPerKwh = tarifDariSetting(
      (await this.prisma.setting.findUnique({ where: { key: 'harga_per_kwh' } }))?.value,
    );

    const baris = await this.prisma.uptimePc.findMany({
      where: { tanggal: { gte: awal, lte: akhir } },
      select: { pcId: true, tanggal: true, detikOnline: true },
    });

    const perPc = new Map<string, Map<string, number>>();
    for (const b of baris) {
      let m = perPc.get(b.pcId);
      if (!m) {
        m = new Map<string, number>();
        perPc.set(b.pcId, m);
      }
      m.set(b.tanggal.toISOString().slice(0, 10), b.detikOnline);
    }

    const tanggal: string[] = [];
    for (let t = awal.getTime(); t <= akhir.getTime(); t += 86_400_000) {
      tanggal.push(new Date(t).toISOString().slice(0, 10));
    }

    return {
      dari,
      sampai,
      tanggal,
      pcs: pcs.map((pc) => {
        const m = perPc.get(pc.id) ?? new Map<string, number>();
        const perHari = tanggal.map((t) => ({ tanggal: t, detik: m.get(t) ?? 0 }));
        const detik = perHari.reduce((jumlah, h) => jumlah + h.detik, 0);
        const watt = wattDariPc(pc.watt);
        const kwh = hitungKwh(detik, watt);
        return {
          id: pc.id,
          namaPc: pc.namaPc,
          detik,
          watt,
          kwh,
          rupiah: hitungRupiah(kwh, tarifPerKwh),
          perHari,
        };
      }),
      listrik: hitungTotal(pcs.map((pc) => {
        const m = perPc.get(pc.id) ?? new Map<string, number>();
        const detik = tanggal.reduce((jumlah, t) => jumlah + (m.get(t) ?? 0), 0);
        return { watt: wattDariPc(pc.watt), detik };
      }), tarifPerKwh),
    };
  }
}

/**
 * Total energi & biaya.
 *
 * ⚠️ Dijumlahkan per PC dari kWh masing-masing, bukan dari
 * `sum(detik) x satu watt`. Menghitung `totalDetik x wattPerPc` hanya benar
 * kalau semua PC sama dayanya, dan tidak ada jaminan begitu. Jumlahkan kWh
 * per PC lalu jumlahkan itu.
 *
 * Pembulatan kWh dilakukan DI AKHIR, bukan per PC: membulatkan 0,0117 menjadi
 * 0,01 untuk 20 PC menghasilkan selisih yang jauh lebih besar daripada
 * pembulatan yang dimaksud.
 */
function hitungTotal(
  perPc: { watt: number; detik: number }[],
  tarifPerKwh: number,
): RingkasanListrik {
  let totalDetik = 0;
  let totalKwh = 0;
  let totalWatt = 0;
  for (const p of perPc) {
    totalDetik += p.detik;
    totalWatt += p.watt;
    totalKwh += hitungKwh(p.detik, p.watt);
  }
  return {
    tarifPerKwh,
    totalDetik,
    totalKwh,
    totalRupiah: hitungRupiah(totalKwh, tarifPerKwh),
    totalWatt,
  };
}

/**
 * Terima tanggal `YYYY-MM-DD` dan kembalikan Date tengah malam UTC.
 *
 * ⚠️ Tanggal dari `tanggalWib()` sudah berupa string WIB, dan kolomnya
 * `DATE`, jadi keduanya dibandingkan sebagai `YYYY-MM-DD`. Kalau diubah jadi
 * objek Date lokal, perbandingan bisa bergeser sehari.
 */
function parseTanggal(nilai: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nilai)) {
    throw new Error('Tanggal harus format YYYY-MM-DD');
  }
  const d = new Date(`${nilai}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Tanggal tidak valid');
  }
  return d;
}

export { parseTanggal, tanggalWib };
