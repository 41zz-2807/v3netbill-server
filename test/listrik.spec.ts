import { describe, expect, it } from 'vitest';
import {
  hitungKwh,
  hitungRupiah,
  tarifDariSetting,
  wattDariPc,
  TARIF_KWH_DEFAULT,
  WATT_PC_DEFAULT,
} from '../src/uptime/listrik.js';

/**
 * Perhitungan biaya listrik.
 *
 * ⚠️ Yang paling dijaga di sini adalah SKALA. Meter rumah 2.200 VA bukan
 * berarti PC memakai 2.200 watt — kalau tercampur, biaya yang tampil sekitar
 * 10x lebih besar dari kenyataan, dan angka itu terlihat "meyakinkan" karena
 * format rupiahnya benar. Tidak ada satu pun error yang muncul.
 *
 * Semua angka di bawah dihitung manual dan diperiksa ulang, bukan diambil
 * dari implementasi yang sedang diuji.
 */
describe('hitungKwh', () => {
  it('150 W selama 1 jam = 0,15 kWh', () => {
    expect(hitungKwh(3600, 150)).toBeCloseTo(0.15, 10);
  });

  it('150 W selama 10 jam = 1,5 kWh', () => {
    expect(hitungKwh(36000, 150)).toBeCloseTo(1.5, 10);
  });

  it('300 W dua kali lipat watt -> dua kali lipat kWh', () => {
    expect(hitungKwh(3600, 300)).toBeCloseTo(0.3, 10);
  });

  it('waktu 10x -> kWh 10x', () => {
    expect(hitungKwh(36000, 150)).toBeCloseTo(hitungKwh(3600, 150) * 10, 10);
  });

  it('⚠️ 2200 W (salah baca VA) memberi kWh ~14,7x lipat dari 150 W', () => {
    // Ini persis kesalahan yang harus dicegah: 2200 VA dibaca sebagai 2200 W.
    expect(hitungKwh(3600, 2200) / hitungKwh(3600, 150)).toBeCloseTo(14.6667, 3);
  });

  it('detik 0 / negatif -> 0, bukan angka negatif', () => {
    expect(hitungKwh(0, 150)).toBe(0);
    expect(hitungKwh(-100, 150)).toBe(0);
  });

  it('watt 0 atau negatif -> 0, tidak jadi NaN', () => {
    // ⚠️ Tanpa penjaga ini hasilnya 0 kWh tapi tidak salah — dan biaya
    // terlihat benar padahal PC-nya salah setelan daya.
    expect(hitungKwh(3600, 0)).toBe(0);
    expect(hitungKwh(3600, -50)).toBe(0);
  });

  it('nilai tidak valid -> 0, bukan NaN', () => {
    expect(hitungKwh(Number.NaN, 150)).toBe(0);
    expect(hitungKwh(3600, Number.NaN)).toBe(0);
  });
});

describe('hitungRupiah', () => {
  it('0,15 kWh x Rp 1.444,70 = Rp 216,705', () => {
    expect(hitungRupiah(0.15, 1444.7)).toBeCloseTo(216.705, 6);
  });

  it('1,5 kWh x Rp 1.444,70 = Rp 2.167,05', () => {
    expect(hitungRupiah(1.5, 1444.7)).toBeCloseTo(2167.05, 6);
  });

  it('kWh 0 -> Rp 0', () => {
    expect(hitungRupiah(0, 1444.7)).toBe(0);
  });

  it('tarif 0 atau negatif -> Rp 0, bukan NaN', () => {
    // ⚠️ Setting `harga_per_kwh` kosong di database adalah keadaan nyata.
    // Tanpa penjaga ini, `NaN * x` menyebar ke seluruh ringkasan dan biaya
    // tampil "Rp NaN" untuk semua PC.
    expect(hitungRupiah(1.5, 0)).toBe(0);
    expect(hitungRupiah(1.5, -100)).toBe(0);
    expect(hitungRupiah(1.5, Number.NaN)).toBe(0);
  });
});

describe('tarifDariSetting', () => {
  it('angka valid -> dipakai apa adanya', () => {
    expect(tarifDariSetting('1444.70')).toBe(1444.7);
  });

  it('koma desimal (gaya Indonesia) diterima', () => {
    expect(tarifDariSetting('1444,70')).toBe(1444.7);
  });

  it('kosong -> tarif default, bukan 0', () => {
    expect(tarifDariSetting('')).toBe(TARIF_KWH_DEFAULT);
    expect(tarifDariSetting(null)).toBe(TARIF_KWH_DEFAULT);
    expect(tarifDariSetting(undefined)).toBe(TARIF_KWH_DEFAULT);
  });

  it('sampah -> tarif default, bukan NaN', () => {
    expect(tarifDariSetting('bukan-angka')).toBe(TARIF_KWH_DEFAULT);
  });

  it('nol atau negatif -> default (biaya Rp 0 selalu salah)', () => {
    expect(tarifDariSetting('0')).toBe(TARIF_KWH_DEFAULT);
    expect(tarifDariSetting('-100')).toBe(TARIF_KWH_DEFAULT);
  });

  it('default PLN 2.200 VA = 1.444,70', () => {
    expect(TARIF_KWH_DEFAULT).toBe(1444.7);
  });
});

describe('wattDariPc', () => {
  it('angka valid -> dipakai apa adanya', () => {
    expect(wattDariPc(150)).toBe(150);
    expect(wattDariPc(300)).toBe(300);
  });

  it('null / 0 -> default, bukan 0 kWh diam-diam', () => {
    expect(wattDariPc(null)).toBe(WATT_PC_DEFAULT);
    expect(wattDariPc(0)).toBe(WATT_PC_DEFAULT);
  });

  it('default 150 W sesuai PC warnet yang dipilih', () => {
    expect(WATT_PC_DEFAULT).toBe(150);
  });
});

/**
 * Sanity check terhadap dunia nyata: satu PC nyala 10 jam sehari selama 30
 * hari. Angka ini jadi acuan kasir, jadi harus masuk akal.
 */
describe('angka dunia nyata', () => {
  it('1 PC, 150 W, 10 jam/hari, 30 hari', () => {
    const detik = 10 * 3600 * 30;
    const kwh = hitungKwh(detik, 150);
    const rupiah = hitungRupiah(kwh, 1444.7);
    expect(kwh).toBeCloseTo(45, 10);
    // 45 kWh x 1.444,70 = Rp 65.011,50
    expect(rupiah).toBeCloseTo(65011.5, 4);
  });

  it('5 PC dengan durasi sama = 5 kali lipat', () => {
    const detik = 10 * 3600 * 30;
    const satu = hitungRupiah(hitungKwh(detik, 150), 1444.7);
    const lima = hitungRupiah(5 * hitungKwh(detik, 150), 1444.7);
    expect(lima).toBeCloseTo(satu * 5, 6);
  });
});
