import { describe, expect, it, vi } from 'vitest';
import { BATAS_LOGIN_PC, TeknisiService } from '../src/session/teknisi.service.js';

/**
 * Tes untuk akses teknisi.
 *
 * ⚠️ Yang paling penting diuji di sini adalah sisi MENOLAK. Akun teknisi
 * membuka PC tanpa penagihan, jadi satu kelonggaran di sini berarti orang
 * bisa memakai PC tanpa bayar.
 *
 * Sesi teknisi juga TIDAK boleh membuat baris `Session`/`Transaction` — itu
 * yang membuatnya tidak masuk `totalLogin` maupun pendapatan laporan.
 */

/**
 * `tek` boleh `null` untuk kasus "akun belum ada". Default-nya objek
 * kosong, bukan `null`, karena hampir semua tes memang butuh akun yang ada.
 */
function harness(
  tek: Record<string, unknown> | null | unknown[] = {},
  sesi: unknown[] = [],
  selesai = false,
) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const prisma = {
    teknisi: {
      findUnique: vi.fn(async () => tek),
      findMany: vi.fn(async () => (Array.isArray(tek) ? tek : tek ? [tek] : [])),
      findFirst: vi.fn(async () => tek),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    sesiTeknisi: {
      findFirst: vi.fn(async () => (sesi[0] ?? null)),
      findMany: vi.fn(async () => sesi),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: selesai ? 1 : 0 })),
      groupBy: vi.fn(async () => []),
    },
    account: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (a: unknown[]) => Promise.all(a as Promise<unknown>[])),
  };
  const svc = new TeknisiService(prisma as never);
  (svc as unknown as { logger: typeof logger }).logger = logger;
  return { svc, prisma, logger };
}

/**
 * hash bcrypt asli — kalau tidak, `compare` selalu false dan tesnya hampa.
 *
 * ⚠️ Panjang PIN di sini 4 karakter, bukan 6, karena itu batas `PasswordBox`
 * di overlay. Tes yang memakai PIN lebih panjang hanya sah untuk
 * `verifikasiLogin` (yang tidak menyentuh validasi panjang) — `simpanAkun`
 * akan menolaknya, dan itu memang yang diuji terpisah.
 */
const PIN = '2807';
let hashPin: string;

describe('TeknisiService', () => {
  beforeAll(async () => {
    const bcrypt = await import('bcrypt');
    hashPin = await bcrypt.hash(PIN, 10);
  });

  describe('verifikasiLogin', () => {
    it('PIN benar + akun aktif -> diterima', async () => {
      const { svc } = harness({ username: 'teknisi', passwordHash: hashPin, aktif: true });
      expect(await svc.verifikasiLogin('teknisi', PIN)).toEqual({ username: 'teknisi' });
    });

    it('PIN salah -> ditolak', async () => {
      const { svc } = harness({ username: 'teknisi', passwordHash: hashPin, aktif: true });
      expect(await svc.verifikasiLogin('teknisi', '999999')).toBeNull();
    });

    // ⚠️ Ini penjaga utama. Sakelar OFF harus benar-benar menutup pintu.
    it('akun NONAKTIF -> ditolak walau PIN benar', async () => {
      const { svc } = harness({ username: 'teknisi', passwordHash: hashPin, aktif: false });
      expect(await svc.verifikasiLogin('teknisi', PIN)).toBeNull();
    });

    it('kode tidak dikenal -> ditolak', async () => {
      const { svc } = harness(null);
      expect(await svc.verifikasiLogin('entah', PIN)).toBeNull();
    });

    it('kode kosong / PIN kosong -> ditolak tanpa query', async () => {
      const { svc, prisma } = harness({ username: 'teknisi', passwordHash: hashPin, aktif: true });
      expect(await svc.verifikasiLogin('', PIN)).toBeNull();
      expect(await svc.verifikasiLogin('teknisi', '')).toBeNull();
      expect(prisma.teknisi.findUnique).not.toHaveBeenCalled();
    });

    // ⚠️ Query yang gagal tidak boleh menjatuhkan backend, dan tidak boleh
    // membuka pintu teknisi.
    it('database menolak -> null, tidak melempar', async () => {
      const { svc, prisma } = harness();
      prisma.teknisi.findUnique.mockRejectedValueOnce(new Error('db mati') as never);
      expect(await svc.verifikasiLogin('teknisi', PIN)).toBeNull();
    });
  });

  describe('namaTeknisiAktif', () => {
    it('hanya mengembalikan yang aktif', async () => {
      const { svc } = harness([{ username: 'teknisi' }] as never);
      expect(await svc.namaTeknisiAktif()).toEqual(['teknisi']);
    });
  });

  describe('sesi', () => {
    const sesiAktif = {
      id: 's1',
      pcId: 'pc1',
      username: 'teknisi',
      mulaiAt: new Date(),
      selesaiAt: null,
    };

    it('semuaSesiAktif -> hanya yang belum selesai', async () => {
      const { svc } = harness({}, [sesiAktif]);
      expect(await svc.semuaSesiAktif()).toHaveLength(1);
      expect((await svc.pcDenganSesiAktif())).toEqual(['pc1']);
    });

    // ⚠️ Satu PC tidak boleh punya dua sesi terbuka: kalau iya, "matikan
    // akses" hanya mengunci satu dari keduanya.
    it('mulaiSesi menutup sesi lama di PC yang sama sebelum membuat yang baru', async () => {
      const { svc, prisma } = harness({}, [sesiAktif]);
      await svc.mulaiSesi('pc1', 'teknisi');
      const [updateMany, create] = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(prisma.sesiTeknisi.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { pcId: 'pc1', selesaiAt: null } }),
      );
      expect(prisma.sesiTeknisi.create).toHaveBeenCalledWith({
        data: { pcId: 'pc1', username: 'teknisi' },
      });
      expect(updateMany).toBeDefined();
      expect(create).toBeDefined();
    });

    it('dua PC di dua sesi -> pcDenganSesiAktif mengembalikan keduanya', async () => {
      const { svc } = harness({}, [
        { ...sesiAktif, id: 's1', pcId: 'pc1' },
        { ...sesiAktif, id: 's2', pcId: 'pc2' },
      ]);
      expect((await svc.pcDenganSesiAktif()).sort()).toEqual(['pc1', 'pc2']);
    });
  });

  describe('setAktif', () => {
    // ⚠️ Urutan yang benar. Versi pertama menutup sesi lebih dulu lalu gateway
    // mencarinya sendiri, hasilnya nol PC terkunci padahal log bilang
    // "harus dikunci" — sakelar terlihat berhasil padahal tidak.
    it('matikan -> mengembalikan daftar PC SEBELUM sesi ditutup', async () => {
      const { svc, prisma } = harness({}, [
        { id: 's1', pcId: 'pc1', username: 'teknisi', mulaiAt: new Date(), selesaiAt: null },
      ]);
      const hasil = await svc.setAktif(false);
      expect(hasil.aktif).toBe(false);
      expect(hasil.pcHarusDikunci).toEqual(['pc1']);
      expect(prisma.sesiTeknisi.updateMany).toHaveBeenCalled();
    });

    it('nyalakan -> tidak ada PC yang dikunci', async () => {
      const { svc } = harness({}, [
        { id: 's1', pcId: 'pc1', username: 'teknisi', mulaiAt: new Date(), selesaiAt: null },
      ]);
      expect((await svc.setAktif(true)).pcHarusDikunci).toEqual([]);
    });

    it('tidak ada sesi -> daftar kosong, tidak error', async () => {
      const { svc } = harness({}, []);
      expect((await svc.setAktif(false)).pcHarusDikunci).toEqual([]);
    });
  });

  describe('simpanAkun', () => {
    // ⚠️ `Account.nama` adalah kredensial login pelanggan. Kalau nama teknisi
    // boleh sama, kode itu cocok ke DUA tempat dan PIN teknisi yang bocor bisa
    // dipakai masuk sebagai pelanggan.
    it('nama yang sudah dipakai akun pelanggan -> DITOLAK', async () => {
      const { svc, prisma } = harness();
      prisma.account.findFirst.mockResolvedValueOnce({ id: 'akun-1' } as never);
      await expect(svc.simpanAkun('977', '1234')).rejects.toThrow(/sudah dipakai akun pelanggan/);
      expect(prisma.teknisi.create).not.toHaveBeenCalled();
    });

    // ⚠️ Batas PIN sekarang MAKSIMUM 4 karakter, bukan minimum — karena
    // `PasswordBox` di overlay punya MaxLength 4. PIN pendek tetap sah; yang
    // tidak bisa dipakai justru PIN panjang.
    it('PIN kosong saat membuat baru -> DITOLAK (hash dari undefined akan crash)', async () => {
      const { svc, prisma } = harness(null);
      await expect(svc.simpanAkun('teknis', '')).rejects.toThrow();
      expect(prisma.teknisi.create).not.toHaveBeenCalled();
    });

    it('nama kosong -> DITOLAK', async () => {
      const { svc } = harness();
      await expect(svc.simpanAkun('   ', '1234')).rejects.toThrow(/tidak boleh kosong/);
    });

    it('nama baru + PIN valid -> dibuat', async () => {
      // `null` = belum ada akun dengan nama itu, jadi harus lewat jalur create.
      const { svc, prisma } = harness(null);
      const hasil = await svc.simpanAkun('teknis', PIN);
      expect(hasil).toEqual({ username: 'teknis' });
      expect(prisma.teknisi.create).toHaveBeenCalled();
    });

    it('akun sudah ada + PIN kosong -> PIN lama tidak ditimpa', async () => {
      const { svc, prisma } = harness({ username: 'teknis', passwordHash: hashPin, aktif: true });
      await svc.simpanAkun('teknis', '');
      expect(prisma.teknisi.update).not.toHaveBeenCalled();
    });
  });
});

/**
 * ⚠️ Batas karakter login PC client.
 *
 * `Agent.Overlay/MainWindow.xaml` memberi `KodeTextBox` MaxLength 6 dan
 * `PasswordBox` MaxLength 4. Jadi kredensial yang lebih panjang tidak akan
 * ditolak server — kredensial itu **tidak akan pernah bisa diketik** di layar
 * PC. Gejalanya: akun terlihat berhasil dibuat di Pengaturan, lalu teknisi
 * mengetik nama lengkap dan field-nya berhenti sendiri.
 *
 * Tes ini mengunci batas itu di sisi server, karena itu satu-satunya tempat
 * yang bisa mencegah akun yang tidak bisa dipakai.
 */
describe('batas karakter yang bisa diketik di layar PC', () => {
  it('nama lebih dari 6 karakter ditolak', async () => {
    const { svc } = harness();
    await expect(svc.simpanAkun('teknisi', '1234')).rejects.toThrow(/maksimal 6 karakter/);
  });

  it('nama tepat 6 karakter diterima', async () => {
    const { svc, prisma } = harness(null);
    await svc.simpanAkun('teknis', '1234');
    expect(prisma.teknisi.create).toHaveBeenCalled();
  });

  it('PIN lebih dari 4 karakter ditolak', async () => {
    const { svc } = harness();
    await expect(svc.simpanAkun('teknis', '280788')).rejects.toThrow(/maksimal 4 karakter/);
  });

  it('PIN tepat 4 karakter diterima', async () => {
    const { svc, prisma } = harness(null);
    await svc.simpanAkun('teknis', '2807');
    expect(prisma.teknisi.create).toHaveBeenCalled();
  });

  it('batasnya dibaca dari konstanta yang sama dengan XAML', async () => {
    // Kalau XAML agent berubah, konstanta ini harus ikut diubah — tes ini
    // hanya memastikan tidak ada angka yang ditulis ulang secara terpisah.
    expect(BATAS_LOGIN_PC).toEqual({ kode: 6, pin: 4 });
  });
});

/**
 * Hapus akun teknisi.
 *
 * ⚠️ Urutan di service ini disengaja dan diuji di sini: sesi yang sedang
 * berjalan harus ditutup **sebelum** akun dihapus. Kalau dibalik, teknisi
 * masih bisa memakai PC sampai logout manual padahal akunnya sudah tidak ada
 * lagi di server — dan tidak ada yang bisa menutup aksesnya kecuali sakelar.
 */
describe('hapusAkun', () => {
  it('mengembalikan daftar PC yang sedang dipakai teknisi itu', async () => {
    const { svc } = harness({}, [
      { username: 'teknis', pcId: 'pc-1' },
      { username: 'teknis', pcId: 'pc-2' },
      { username: 'teknis', pcId: 'pc-1' },
    ]);
    await expect(svc.hapusAkun('teknis')).resolves.toEqual(['pc-1', 'pc-2']);
  });

  it('tidak ikut mengunci PC milik teknisi lain', async () => {
    const { svc } = harness({}, [
      { username: 'teknis', pcId: 'pc-1' },
      { username: 'lain', pcId: 'pc-9' },
    ]);
    await expect(svc.hapusAkun('teknis')).resolves.toEqual(['pc-1']);
  });

  it('menutup sesi teknisi sebelum akun dihapus', async () => {
    const { svc, prisma } = harness({}, [{ username: 'teknis', pcId: 'pc-1' }]);
    const urutan: string[] = [];
    prisma.sesiTeknisi.updateMany.mockImplementation(async () => {
      urutan.push('sesi Ditutup');
      return { count: 1 };
    });
    prisma.teknisi.deleteMany.mockImplementation(async () => {
      urutan.push('akun dihapus');
      return { count: 1 };
    });
    await svc.hapusAkun('teknis');
    expect(urutan).toEqual(['sesi Ditutup', 'akun dihapus']);
  });

  it('berhasil walau tidak ada sesi yang sedang berjalan', async () => {
    const { svc } = harness({}, []);
    await expect(svc.hapusAkun('teknis')).resolves.toEqual([]);
  });

  it('tidak melempar walau username tidak ada', async () => {
    const { svc } = harness({}, []);
    await expect(svc.hapusAkun('entah')).resolves.toEqual([]);
  });
});

/**
 * ⚠️ Tombol STOP di layar PC client.
 *
 * `stop_session` dari PC memanggil `unlockPc()`, yang dulunya hanya mencari
 * baris `Session` BERJALAN. Teknisi **sengaja tidak punya** baris itu, jadi
 * hasilnya "tidak ada sesi aktif" — PC tetap terbuka dan teknisi tidak punya
 * jalan keluar selain dashboard operator.
 */
describe('selesaiSesiUntukPc (tombol STOP di PC client)', () => {
  it('menutup sesi dan mengembalikan username', async () => {
    const { svc } = harness({}, [{ username: 'tech', pcId: 'pc-1' }], true);
    await expect(svc.selesaiSesiUntukPc('pc-1')).resolves.toBe('tech');
  });

  it('mengembalikan null kalau tidak ada sesi di PC itu', async () => {
    const { svc } = harness({}, [], false);
    await expect(svc.selesaiSesiUntukPc('pc-1')).resolves.toBeNull();
  });

  it('hanya menutup sesi PC itu, bukan PC lain', async () => {
    const { svc, prisma } = harness({}, [{ username: 'tech', pcId: 'pc-1' }], true);
    await svc.selesaiSesiUntukPc('pc-2');
    const where = prisma.sesiTeknisi.updateMany.mock.calls[0][0].where;
    expect(where.pcId).toBe('pc-2');
    expect(where.selesaiAt).toBeNull();
  });

  it('berhasil walau tabel sesi teknisi kosong', async () => {
    const { svc } = harness({}, [], false);
    await expect(svc.selesaiSesiUntukPc('pc-1')).resolves.toBeNull();
  });
});
