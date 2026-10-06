import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { tanggalWib } from '../common/wib-date.js';

export interface UptimePerHari {
  tanggal: string;
  detik: number;
}

export interface UptimePc {
  id: string;
  namaPc: string;
  /** Total heartbeat yang diterima dalam rentang yang diminta, dalam detik. */
  detik: number;
  perHari: UptimePerHari[];
}

export interface UptimeRingkasan {
  dari: string;
  sampai: string;
  /** Daftar tanggal dalam rentang, termasuk yang nol — supaya grafik tidak
   *  hopping Restricted: hari tanpa data tetap punya titik di sumbu X. */
  tanggal: string[];
  pcs: UptimePc[];
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
      select: { id: true, namaPc: true },
      orderBy: { namaPc: 'asc' },
    });

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
        return {
          id: pc.id,
          namaPc: pc.namaPc,
          detik: perHari.reduce((jumlah, h) => jumlah + h.detik, 0),
          perHari,
        };
      }),
    };
  }
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
