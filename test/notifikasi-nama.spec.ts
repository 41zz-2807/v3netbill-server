import { describe, expect, it } from 'vitest';
import { AccountType } from '@prisma/client';
import { sensorNama } from '../src/notifikasi/notifikasi.service.js';

// ⚠️ WAJIB import dari modul asli, bukan menyalin logikanya di sini.
// Tes yang menyalin konfigurasi produksi hanya mengulang nilai itu — kalau
// logikanya salah, tesnya mengabadikan kesalahan dan bersertifikat hijau.

describe('sensorNama', () => {
  // Nama member ADALAH kredensial login-nya (`session.service.ts` mencocokkan
  // `nama` persis), dan notifikasi Android tampil di layar kunci HP. Jadi nama
  // tidak boleh bocor penuh — hanya 2 karakter pertama.
  it('nama panjang jadi 2 karakter pertama + ***', () => {
    expect(sensorNama('Budi Santoso')).toBe('Bu***');
  });

  it('nama pendek tetap dapat 2 huruf + ***', () => {
    expect(sensorNama('Bu')).toBe('Bu***');
  });

  it('nama 1 huruf tidak jadi kosong', () => {
    expect(sensorNama('B')).toBe('B***');
  });

  it('null, undefined, dan kosong jadi "-"', () => {
    expect(sensorNama(null)).toBe('-');
    expect(sensorNama(undefined)).toBe('-');
    expect(sensorNama('   ')).toBe('-');
  });

  it('spasi di depan tidak menambah karakter sensor', () => {
    expect(sensorNama('  Budi')).toBe('Bu***');
  });

  it('TIDAK PERNAH mengembalikan nama penuh', () => {
    for (const nama of ['Budi Santoso', 'Rina', 'A', 'ab']) {
      expect(sensorNama(nama)).not.toBe(nama);
    }
  });
});

describe('AccountType yang dipakai notifikasi', () => {
  it('MEMBER dan VOUCHER keduanya ada di enum', () => {
    // Notifikasi memilih identitas berdasarkan tipe: kode voucher vs nama member.
    expect(AccountType.MEMBER).toBe('MEMBER');
    expect(AccountType.VOUCHER).toBe('VOUCHER');
  });
});
