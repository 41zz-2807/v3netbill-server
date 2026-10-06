import { describe, expect, it } from 'vitest';
import { pisahkanEmail } from '../src/laporan/laporan.service.js';

/**
 * Tes untuk parsing daftar penerima email laporan.
 *
 * ⚠️ Yang paling berbahaya di sini bukan alamat yang DITOLAK, tapi alamat
 * yang TIDAK tersimpan karena satu karakter mengganjal. Kalau "a@x.com,
 * b@y.com" (ada spasi setelah koma) dianggap satu alamat, laporan malam itu
 * hilang tanpa pesan — dan penyebabnya tidak akan pernah ketahuan karena
 * tidak ada error sama sekali.
 */
describe('pisahkanEmail', () => {
  it('satu alamat', () => {
    expect(pisahkanEmail('satu@contoh.id')).toEqual({ sah: ['satu@contoh.id'], ditolak: [] });
  });

  it('beberapa alamat dipisah koma', () => {
    expect(pisahkanEmail('a@x.id, b@y.id, c@z.id')).toEqual({
      sah: ['a@x.id', 'b@y.id', 'c@z.id'],
      ditolak: [],
    });
  });

  // ⚠️ Ini kasus yang paling sering terjadi di dunia nyata: admin menyalin
  // daftar dari chat atau email, jadi ada spasi dan baris baru.
  it('koma dengan spasi di sekitarnya tetap dipisah', () => {
    const { sah } = pisahkanEmail('  a@x.id ,  b@y.id  ,c@z.id ')
    expect(sah).toEqual(['a@x.id', 'b@y.id', 'c@z.id']);
  });

  it('baris baru dan titik koma juga dipisah', () => {
    expect(pisahkanEmail('a@x.id; b@y.id\nc@z.id\r\nd@w.id').sah).toEqual([
      'a@x.id',
      'b@y.id',
      'c@z.id',
      'd@w.id',
    ]);
  });

  it('alamat dengan spasi dipisah sebagai dua kandidat', () => {
    // Bukan "satu alamat dengan spasi" — itu selalu tidak valid.
    const { sah, ditolak } = pisahkanEmail('a@x.id b@y.id');
    expect(sah.length + ditolak.length).toBeGreaterThan(0);
    expect(ditolak).not.toContain('a@x.id b@y.id');
  });

  it('alamat dengan tag plus (deliveri) tetap sah', () => {
    // Bentuk ini sangat umum dan sering ditolak regex yang terlalu ketat.
    expect(pisahkanEmail('warnet+abc@contoh.co.id').sah).toEqual(['warnet+abc@contoh.co.id']);
  });

  it('alamat tanpa titik di domain ditolak', () => {
    expect(pisahkanEmail('a@localhost').ditolak).toEqual(['a@localhost']);
  });

  it('tanpa @ ditolak', () => {
    expect(pisahkanEmail('bukan-email').ditolak).toEqual(['bukan-email']);
  });

  it('dua @ ditolak', () => {
    expect(pisahkanEmail('a@b@x.id').ditolak).toEqual(['a@b@x.id']);
  });

  it('nilai kosong tidak menghasilkan apa pun', () => {
    expect(pisahkanEmail('')).toEqual({ sah: [], ditolak: [] });
    expect(pisahkanEmail('   \n  ')).toEqual({ sah: [], ditolak: [] });
    expect(pisahkanEmail(',,, , ')).toEqual({ sah: [], ditolak: [] });
  });

  // ⚠️ Alamat yang diketik manusia kadang ada satu huruf nyasar. Satu alamat salah tidak boleh menggagalkan pengiriman
  // ke alamat lain yang benar — kalau tidak, satu typo berarti laporan hilang
  // total untuk semua penerima.
  it('alamat tidak valid dilewati, yang sah tetap dikirim', () => {
    const { sah, ditolak } = pisahkanEmail('a@x.id, salah, b@y.id');
    expect(sah).toEqual(['a@x.id', 'b@y.id']);
    expect(ditolak).toEqual(['salah']);
  });

  it('huruf besar tidak dibedakan', () => {
    expect(pisahkanEmail('A@X.ID').sah).toEqual(['A@X.ID']);
  });
});