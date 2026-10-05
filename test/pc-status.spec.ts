import { describe, expect, it } from 'vitest';
import { PcStatus } from '@prisma/client';
import { AMBANG_OFFLINE_MS, statusPcDitampilkan, statusPcEfektif } from '../src/pc/pc-status.js';

const SEKARANG = new Date('2026-10-04T10:00:00.000Z');
const detikLalu = (detik: number) => new Date(SEKARANG.getTime() - detik * 1000);

describe('statusPcEfektif', () => {
  it('belum pernah connect berarti OFFLINE, bukan IDLE', () => {
    expect(statusPcEfektif(PcStatus.IDLE, null, SEKARANG)).toBe(PcStatus.OFFLINE);
  });

  it('heartbeat tepat ambang sudah OFFLINE', () => {
    expect(
      statusPcEfektif(PcStatus.IDLE, detikLalu(AMBANG_OFFLINE_MS / 1000), SEKARANG),
    ).toBe(PcStatus.OFFLINE);
  });

  it('heartbeat di bawah ambang memakai nilai kolom', () => {
    expect(
      statusPcEfektif(PcStatus.ACTIVE, detikLalu(AMBANG_OFFLINE_MS / 1000 - 1), SEKARANG),
    ).toBe(PcStatus.ACTIVE);
  });
});

describe('statusPcDitampilkan', () => {
  // Ini regresi bug yang dilaporkan: `checkPcOffline()` menulis OFFLINE ke kolom
  // `status`, `heartbeat()` dulu tidak pernah memulihkannya, dan agent yang
  // tetap konek hanya kirim `lastHeartbeatAt`. Dashboard lalu kehilangan hitung
  // mundur dan menampilkan tombol Start pada PC yang sedang tersesi.
  it('kolom OFFLINE + agent sehat + ada sesi -> ACTIVE', () => {
    expect(
      statusPcDitampilkan(PcStatus.OFFLINE, detikLalu(5), true, SEKARANG),
    ).toBe(PcStatus.ACTIVE);
  });

  it('kolom OFFLINE + agent sehat + tanpa sesi -> tetap OFFLINE', () => {
    expect(
      statusPcDitampilkan(PcStatus.OFFLINE, detikLalu(5), false, SEKARANG),
    ).toBe(PcStatus.OFFLINE);
  });

  it('kolom IDLE + agent sehat + ada sesi -> ACTIVE', () => {
    expect(statusPcDitampilkan(PcStatus.IDLE, detikLalu(1), true, SEKARANG)).toBe(
      PcStatus.ACTIVE,
    );
  });

  it('kolom IDLE + agent sehat + tanpa sesi -> IDLE', () => {
    expect(statusPcDitampilkan(PcStatus.IDLE, detikLalu(1), false, SEKARANG)).toBe(
      PcStatus.IDLE,
    );
  });

  // Selama grace period masih ada Session BERJALAN sementara agent sudah putus.
  // Sesi tidak boleh menang, kalau tidak dashboard menampilkan hitung mundur
  // yang tidak lagi bergerak berdampingan dengan tombol Start.
  it('heartbeat basi + ada sesi -> OFFLINE, bukan ACTIVE', () => {
    expect(
      statusPcDitampilkan(PcStatus.ACTIVE, detikLalu(45), true, SEKARANG),
    ).toBe(PcStatus.OFFLINE);
  });

  it('belum pernah connect + ada sesi -> OFFLINE', () => {
    expect(statusPcDitampilkan(PcStatus.ACTIVE, null, true, SEKARANG)).toBe(
      PcStatus.OFFLINE,
    );
  });
});

// Regresi 4 Okt: di `getDashboardData()` pemeriksaan sesi pernah ditulis
// `session !== null`, padahal `Map.get()` mengembalikan `undefined` untuk kunci
// yang tidak ada — dan `undefined !== null` itu TRUE. Akibatnya SETIAP PC tanpa
// sesi terbaca ACTIVE, jadi card PC idle tampil "Aktif". Unit test di atas tidak
// menangkapnya karena parameternya sudah berupa boolean; yang perlu dijaga
// adalah bentuk pemanggilannya.
describe('pola pemanggilan di getDashboardData()', () => {
  it('Map tanpa sesi harus menghasilkan IDLE, bukan ACTIVE', () => {
    const sessionByPc = new Map<string, { id: string }>([['pc-ada-sesi', { id: 's1' }]]);

    expect(
      statusPcDitampilkan(
        PcStatus.IDLE,
        detikLalu(1),
        sessionByPc.has('pc-tidak-ada-sesi'),
        SEKARANG,
      ),
    ).toBe(PcStatus.IDLE);

    expect(
      statusPcDitampilkan(PcStatus.IDLE, detikLalu(1), sessionByPc.has('pc-ada-sesi'), SEKARANG),
    ).toBe(PcStatus.ACTIVE);
  });

  it('sessionByPc.get() untuk kunci yang tidak ada bernilai undefined, bukan null', () => {
    const sessionByPc = new Map<string, { id: string }>();
    const session = sessionByPc.get('pc-tidak-ada-sesi');
    expect(session).toBeUndefined();
    // Inilah jebakannya: perbandingan yang salah ini selalu bernilai true.
    expect(session !== null).toBe(true);
  });
});