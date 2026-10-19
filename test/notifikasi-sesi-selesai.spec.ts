import { describe, expect, it, vi } from 'vitest';
import { AccountType } from '@prisma/client';
import { NotifikasiService } from '../src/notifikasi/notifikasi.service.js';

/**
 * Tes notifikasi "sesi selesai".
 *
 * Dua hal yang dijaga di sini:
 *
 * 1. Isi pesan. Durasi yang ditulis harus yang benar-benar terpakai, dan
 *    sisa waktu harus jujur -- "tanpa sisa" bukan kalimat kosong.
 * 2. Token FCM yang ditolak harus menghapus ID yang BENAR. Versi lama
 *    memakai indeks dari array hasil filter, jadi indeks kedua yang salah.
 */

type HasilKirim = { ok: boolean; tokenMati: boolean; kode?: string; pesan?: string };

function buatService(hasilPerToken: HasilKirim[]) {
  const perangkat = hasilPerToken.map((_, i) => ({ id: `perangkat-${i + 1}`, token: `tok-${i + 1}` }));
  const terkirim: Array<{ token: string; pesan: Record<string, unknown> }> = [];
  const dihapus: string[] = [];

  const prisma = {
    perangkat: {
      findMany: vi.fn(async () => perangkat),
      deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        dihapus.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      }),
    },
  };

  const fcm = {
    kirim: vi.fn(async (token: string, pesan: Record<string, unknown>) => {
      terkirim.push({ token, pesan });
      const i = Number(token.replace('tok-', '')) - 1;
      return hasilPerToken[i];
    }),
  };

  const svc = new NotifikasiService(prisma as never, fcm as never);
  return { svc, terkirim, dihapus, fcm };
}

const member = {
  namaPc: 'PC004',
  tipe: AccountType.MEMBER,
  kodeUnik: null,
  nama: 'Gesper',
};

describe('kirimSesiSelesai', () => {
  it('isi memuat durasi main dan sisa yang dikembalikan', async () => {
    const { svc, terkirim } = buatService([{ ok: true, tokenMati: false }]);
    await svc.kirimSesiSelesai(member, 72 * 60, 20 * 60);

    expect(terkirim).toHaveLength(1);
    const pesan = terkirim[0].pesan as {
      judul: string;
      isi: string;
      data: Record<string, string>;
    };
    expect(pesan.judul).toBe('Sesi selesai');
    // 72 menit = 1j 12m, sisa 20 menit.
    expect(pesan.isi).toContain('main 1j 12m');
    expect(pesan.isi).toContain('sisa 20m dikembalikan');
    expect(pesan.isi).toContain('PC004');
    // 🔴 Nama member adalah kredensial login-nya dan notifikasi ini muncul
    // di layar kunci HP, jadi tidak boleh bocor penuh.
    expect(pesan.isi).toContain('Ge***');
    expect(pesan.isi).not.toContain('Gesper');
    expect(pesan.data['jenis']).toBe('sesi_selesai');
    expect(pesan.data['durasiDetik']).toBe(String(72 * 60));
  });

  it('sisa 0 ditulis "tanpa sisa", bukan disembunyikan', async () => {
    // 🔴 Waktu habis memang tidak mengembalikan apa pun. Kalau kalimatnya
    // hilang, operator tidak bisa membedakan "dihentikan kasir dengan sisa 1
    // menit" dari "waktu habis", padahal keduanya beda jauh untuk uang.
    const { svc, terkirim } = buatService([{ ok: true, tokenMati: false }]);
    await svc.kirimSesiSelesai(member, 60 * 60, 0);

    const isi = (terkirim[0].pesan as { isi: string }).isi;
    expect(isi).toContain('tanpa sisa');
    expect(isi).not.toContain('dikembalikan');
  });

  it('durasi negatif tidak membuat kalimat aneh', async () => {
    const { svc, terkirim } = buatService([{ ok: true, tokenMati: false }]);
    await svc.kirimSesiSelesai(member, -50, 0);
    const isi = (terkirim[0].pesan as { isi: string }).isi;
    expect(isi).toContain('main 0 dtk');
  });

  it('voucher memakai kode unik, bukan nama tersensor', async () => {
    const { svc, terkirim } = buatService([{ ok: true, tokenMati: false }]);
    await svc.kirimSesiSelesai(
      { namaPc: 'PC005', tipe: AccountType.VOUCHER, kodeUnik: '500344', nama: null },
      600,
      0,
    );
    const isi = (terkirim[0].pesan as { isi: string }).isi;
    expect(isi).toContain('Voucher 500344');
  });
});

describe('pembersihan token FCM yang ditolak', () => {
  it('menghapus token yang benar, bukan indeks yang sama posisinya', async () => {
    // 🔴 Regresi untuk bug yang sudah ada di produksi.
    //
    // Versi lama: `hasil.filter(h => h.tokenMati).map((h, i) => perangkat[i].id)`
    //
    // `i` di situ adalah indeks DARI ARRAY HASIL FILTER. Di sini hanya token
    // kedua yang ditolak, jadi array hasil filter berisi satu elemen dengan
    // `i === 0` -- dan yang terhapus adalah token perangkat PERTAMA yang
    // masih hidup. Admins itu langsung berhenti menerima notifikasi, tanpa
    // satu pun error yang terlihat.
    const { svc, dihapus } = buatService([
      { ok: true, tokenMati: false },
      { ok: false, tokenMati: true },
    ]);

    await svc.kirimSesiSelesai(member, 600, 0);

    expect(dihapus).toEqual(['perangkat-2']);
    expect(dihapus).not.toContain('perangkat-1');
  });

  it('tidak menghapus apa pun kalau semua token sehat', async () => {
    const { svc, dihapus } = buatService([
      { ok: true, tokenMati: false },
      { ok: true, tokenMati: false },
    ]);
    await svc.kirimSesiSelesai(member, 600, 0);
    expect(dihapus).toEqual([]);
  });

  it('tidak mengirim ke perangkat kalau admin belum mendaftarkan token', async () => {
    const prisma = { perangkat: { findMany: vi.fn(async () => []), deleteMany: vi.fn() } };
    const fcm = { kirim: vi.fn() };
    const svc = new NotifikasiService(prisma as never, fcm as never);
    await svc.kirimSesiSelesai(member, 600, 0);
    expect(fcm.kirim).not.toHaveBeenCalled();
  });
});

describe('notifikasi sesi dimulai tetap utuh', () => {
  // ⚠️ Refactor ke `kirimKeAdmin` menyentuh kedua method lama. Kalau salah
  // satu rusak, admin berhenti tahu PC sedang dipakai — dan tidak ada yang
  // bakal mengatakannya.
  it('judul dan isi tidak berubah', async () => {
    const { svc, terkirim } = buatService([{ ok: true, tokenMati: false }]);
    await svc.kirimSesiMulai(member, 'PC');

    const pesan = terkirim[0].pesan as { judul: string; isi: string };
    expect(pesan.judul).toBe('Sesi dimulai');
    expect(pesan.isi).toBe('Member Ge*** · PC004 (PC)');
  });

  it('koneksi terputus masih punya judul sendiri', async () => {
    const { svc, terkirim } = buatService([{ ok: true, tokenMati: false }]);
    await svc.kirimSesiTerputus(member, 15 * 60);

    const pesan = terkirim[0].pesan as { judul: string; isi: string };
    expect(pesan.judul).toBe('Koneksi terputus');
    expect(pesan.isi).toContain('sisa 15m dikembalikan');
  });
});