import { describe, expect, it } from 'vitest';
import { akhirHariWib, awalHariWib, tanggalWib } from '../src/common/wib-date.js';

const wib = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString();

describe('awalHariWib', () => {
  it('00:00 WIB, bukan 00:00 UTC', () => {
    expect(awalHariWib('2026-10-04').toISOString()).toBe('2026-10-03T17:00:00.000Z');
    expect(wib(awalHariWib('2026-10-04'))).toBe('2026-10-04T00:00:00.000Z');
  });

  // `new Date('2026-10-04')` = 00:00 UTC = 07:00 WIB, jadi transaksi 00:00-06:59
  // WIB hilang dari filter. Inilah bug yang membuat "dari" misses 7 jam pertama.
  it('batas bawah lebih awal dari 00:00 UTC', () => {
    expect(awalHariWib('2026-10-04').getTime()).toBeLessThan(
      new Date('2026-10-04').getTime(),
    );
  });

  it('handle bulan dan tahun rollover', () => {
    expect(awalHariWib('2026-01-01').toISOString()).toBe('2025-12-31T17:00:00.000Z');
    expect(awalHariWib('2026-03-01').toISOString()).toBe('2026-02-28T17:00:00.000Z');
  });
});

describe('akhirHariWib', () => {
  it('23:59:59.999 WIB', () => {
    expect(akhirHariWib('2026-10-04').toISOString()).toBe('2026-10-04T16:59:59.999Z');
    expect(wib(akhirHariWib('2026-10-04'))).toBe('2026-10-04T23:59:59.999Z');
  });

  // `setHours(23,59,59,999)` di server UTC = 23:59 UTC = 06:59 WIB tomorrow,
  // jadi transaksi 00:00-06:59 WIB hari berikutnya ikut masuk.
  // Perbandingan ditulis eksplisit `Date.UTC`, bukan `setHours`, supaya tes ini
  // tidak bergantung pada `TZ` container (sejak 7 Okt container = Asia/Jakarta).
  it('batas atas 7 jam lebih awal daripada setHours di server UTC', () => {
    const batasLamaUtc = Date.UTC(2026, 9, 4, 23, 59, 59, 999);
    expect(akhirHariWib('2026-10-04').getTime()).toBe(batasLamaUtc - 7 * 3600_000);
  });
});

describe('tanggalWib', () => {
  // Bug nama berkas log billing: `toISOString().slice(0,10)` mengembalikan
  // tanggal UTC, jadi WIB 00:00-06:59 masuk berkas bertanggal kemarin.
  it('WIB 00:30 sudah tanggal yang sama, bukan kemarin', () => {
    // 04 Okt 17:30 UTC = 05 Okt 00:30 WIB
    expect(tanggalWib(new Date('2026-10-04T17:30:00Z'))).toBe('2026-10-05');
  });

  it('WIB 06:59 (17:59 UTC) masih tanggal berikutnya', () => {
    expect(tanggalWib(new Date('2026-10-04T17:59:00Z'))).toBe('2026-10-05');
  });

  it('WIB 07:00 (00:00 UTC) batasnya tepat berganti', () => {
    expect(tanggalWib(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05');
    expect(tanggalWib(new Date('2026-10-04T23:59:59Z'))).toBe('2026-10-05');
  });

  it('beda dari tanggal UTC pada jam-jam WIB malam', () => {
    const inst = new Date('2026-10-04T18:00:00Z'); // 05 Okt 01:00 WIB
    expect(inst.toISOString().slice(0, 10)).toBe('2026-10-04');
    expect(tanggalWib(inst)).toBe('2026-10-05');
  });
});
