import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetAutoUpdatePcDto } from '../src/pc/dto/set-auto-update-pc.dto.js';
import { PcService, bisaAutoUpdate } from '../src/pc/pc.service.js';

/**
 * Tes untuk flag pembaruan otomatis per-PC.
 *
 * Ini menggantikan desain sakelar global, yang dibatalkan karena menyalakannya
 * akan menggerakkan SEMUA agent yang tersambung — termasuk PC yang sedang dipakai
 * pelanggan. Flag per-PC membuat mustahil menyentuh PC yang tidak dipilih.
 *
 * Yang paling dijaga di sini:
 *
 * 1. **Sesi yang sedang berjalan TIDAK dihentikan.** Menolak toggle karena ada
 *    sesi akan terasa seperti sistem tidak mau melayani pelanggan; operator
 *    sudah memutuskan toggle tetap boleh ON dan update menunggu sesi selesai.
 * 2. **PC versi lama ditolak.** Kalau tidak, PC itu menolak sesi, tidak pernah
 *    dimatikan otomatis, DAN tidak akan pernah update — terkunci selamanya.
 * 3. **Satu PC gagal tidak membatalkan yang lain.** Operator memilih 5 PC;
 *    kalau satu versinya lama, 4 yang lain tetap harus diperbarui.
 */

function buatPcService(opsi: {
  pc?: {
    id: string;
    namaPc: string;
    rusak?: boolean;
    versiAgent?: string | null;
  } | null;
}) {
  const pc = opsi.pc ?? null;

  const update = vi.fn(async () => ({}));
  // ⚠️ findUnique WAJIB mengembalikan PC yang diminta. Versi pertama selalu
  // mengembalikan null, jadi 10 dari 14 tes gagal dengan "PC not found" —
  // gejalanya seperti kode salah, padahal mock-nya yang salah.
  const findUnique = vi.fn(async ({ where }: { where: { id?: string } }) => {
    if (!pc) return null;
    if (where.id && pc.id !== where.id) return null;
    return pc;
  });
  const updateMany = vi.fn(async () => ({ count: 0 }));
  const session = { findFirst: vi.fn(async () => null) };

  const prisma = {
    pc: { findUnique, update, updateMany },
    session,
    setting: { findUnique: vi.fn(async () => null) },
  };

  const kirimAutoUpdateConfig = vi.fn(async () => true);
  const kunciLayarPc = vi.fn(async () => {});
  const broadcastPcUpdate = vi.fn(async () => {});

  const sessionService = {
    kirimAutoUpdateConfig,
    kunciLayarPc,
    broadcastPcUpdate,
    stopSession: vi.fn(async () => {}),
  };

  const tulisLog = vi.fn();
  const svc = new PcService(
    prisma as never,
    { catat: vi.fn(), tulis: tulisLog, invalidateNamaPc: vi.fn() } as never,
    sessionService as never,
  );
  return { svc, prisma, update, findUnique, sessionService, kirimAutoUpdateConfig };
}

/** PATCH /pcs/auto-update memanggil setAutoUpdate per id. */
const PC_BISA = { id: 'pc-1', namaPc: 'PC001', versiAgent: '1.0.26.0' };
const PC_LAMA = { id: 'pc-2', namaPc: 'PC002', versiAgent: '1.0.24.0' };

describe('bisaAutoUpdate', () => {
  it('versi 1.0.26.0 dan lebih baru bisa', () => {
    expect(bisaAutoUpdate('1.0.26.0')).toBe(true);
    expect(bisaAutoUpdate('1.0.27.0')).toBe(true);
    expect(bisaAutoUpdate('1.1.0')).toBe(true);
    expect(bisaAutoUpdate('2.0.0')).toBe(true);
  });

  it('versi sebelum 1.0.26.0 tidak bisa', () => {
    expect(bisaAutoUpdate('1.0.25.0')).toBe(false);
    expect(bisaAutoUpdate('1.0.24.0')).toBe(false);
    expect(bisaAutoUpdate('1.0.9.0')).toBe(false);
  });

  // 🔴 Jebakan yang paling mudah lolos: "1.0.100.0" vs "1.0.26.0".
  //
  // Secara leksikografis "1" datang sebelum "2", jadi perbandingan string
  // menyimpulkan 1.0.100.0 LEBIH KECIL dari 1.0.26.0 dan menolak PC itu —
  // padahal 100 jelas lebih besar dari 26. Gejalanya di produksi: PC versi
  // tinggi ditolak untuk update, dan tidak ada pesan yang mengarah ke
  // perbandingan versi.
  it('perbandingan versi numerik, bukan leksikografis', () => {
    expect(bisaAutoUpdate('1.0.100.0')).toBe(true);
    expect(bisaAutoUpdate('1.10.0.0')).toBe(true);
    expect(bisaAutoUpdate('1.0.999.0')).toBe(true);
    // 10 < 26, jadi memang ditolak — ini yang memastikan test di atas bukan
    // sekadar menerima apa pun.
    expect(bisaAutoUpdate('1.0.10.0')).toBe(false);
  });

  it('versi rusak / kosong dianggap tidak bisa (jangan menebak)', () => {
    expect(bisaAutoUpdate(null)).toBe(false);
    expect(bisaAutoUpdate(undefined)).toBe(false);
    expect(bisaAutoUpdate('')).toBe(false);
    expect(bisaAutoUpdate('   ')).toBe(false);
    expect(bisaAutoUpdate('abc')).toBe(false);
    expect(bisaAutoUpdate('1.0.26.0-rc1')).toBe(false);
    expect(bisaAutoUpdate('1.0')).toBe(false);
    expect(bisaAutoUpdate('1.0.26.0.0')).toBe(false);
  });
});

describe('setAutoUpdate — menyalakan', () => {
  it('menyimpan flag dan mengirim config ke agent PC itu', async () => {
    const { svc, update, kirimAutoUpdateConfig } = buatPcService({ pc: PC_BISA });

    const hasil = await svc.setAutoUpdate('pc-1', true);

    expect(hasil.autoUpdate).toBe(true);
    expect(hasil.namaPc).toBe('PC001');
    const data = update.mock.calls[0][0].data;
    expect(data.autoUpdate).toBe(true);
    expect(kirimAutoUpdateConfig).toHaveBeenCalledWith('pc-1', true);
  });

  // 🔴 Ini yang ditolak operator dan TIDAK boleh dibalik: sesi sedang
  // berjalan harus dibiarkan.
  it('TIDAK menghentikan sesi yang sedang berjalan', async () => {
    const { svc, sessionService } = buatPcService({ pc: PC_BISA });

    await svc.setAutoUpdate('pc-1', true);

    expect(sessionService.stopSession).not.toHaveBeenCalled();
  });

  it('mengunci layar PC supaya pelanggan tidak melihat login yang pasti ditolak', async () => {
    const { svc, sessionService } = buatPcService({ pc: PC_BISA });

    await svc.setAutoUpdate('pc-1', true);

    expect(sessionService.kunciLayarPc).toHaveBeenCalledWith('pc-1');
  });

  it('agent offline -> flag TETAP disimpan dan nilai balik=false', async () => {
    const { svc, update, kirimAutoUpdateConfig } = buatPcService({ pc: PC_BISA });
    kirimAutoUpdateConfig.mockResolvedValue(false as never);

    const hasil = await svc.setAutoUpdate('pc-1', true);

    // ⚠️ Flag harus tetap true. Kalau ikut dibatalkan karena agent offline,
    // PC itu akan menunggu operator menyalakannya lagi — padahal begitu
    // agent konek, dia akan melanjutkannya sendiri dari registry.
    expect(hasil.terkirim).toBe(false);
    expect(update.mock.calls[0][0].data.autoUpdate).toBe(true);
  });

  it('PC versi lama ditolak dengan pesan yang menjelaskan apa yang harus dilakukan', async () => {
    const { svc, update } = buatPcService({ pc: PC_LAMA });

    await expect(svc.setAutoUpdate('pc-2', true)).rejects.toThrow(/1\.0\.26\.0/);
    expect(update).not.toHaveBeenCalled();
  });

  it('PC tidak ditemukan -> NotFound', async () => {
    const { svc } = buatPcService({ pc: null });

    await expect(svc.setAutoUpdate('pc-hantu', true)).rejects.toThrow('PC not found');
  });

  it('membuang sisa kegagalan percobaan sebelumnya saat dinyalakan ulang', async () => {
    const { svc, update } = buatPcService({ pc: PC_BISA });

    await svc.setAutoUpdate('pc-1', true);

    const data = update.mock.calls[0][0].data;
    // ⚠️ Kalau pesan lama dibiarkan, operator akan mengira percobaan yang
    // sedang berjalan sudah pernah gagal.
    expect(data.autoUpdatePesan).toBeNull();
  });
});

describe('setAutoUpdate — mematikan', () => {
  it('flag mati dan progres dikosongkan', async () => {
    const { svc, update, kirimAutoUpdateConfig } = buatPcService({ pc: PC_BISA });

    const hasil = await svc.setAutoUpdate('pc-1', false);

    expect(hasil.autoUpdate).toBe(false);
    const data = update.mock.calls[0][0].data;
    expect(data.autoUpdate).toBe(false);
    expect(data.autoUpdatePercen).toBeNull();
    expect(kirimAutoUpdateConfig).toHaveBeenCalledWith('pc-1', false);
  });

  it('PC versi lama TETAP boleh dimatikan — ini jalur pemulihan', async () => {
    const { svc, update } = buatPcService({ pc: PC_LAMA });

    const hasil = await svc.setAutoUpdate('pc-2', false);

    expect(hasil.autoUpdate).toBe(false);
    expect(update).toHaveBeenCalled();
  });

  it('tidak mengunci layar saat dimatikan', async () => {
    const { svc, sessionService } = buatPcService({ pc: PC_BISA });

    await svc.setAutoUpdate('pc-1', false);

    expect(sessionService.kunciLayarPc).not.toHaveBeenCalled();
  });
});
/**
 * 🔴 Regresi: `@IsString()` tanpa `@IsOptional()` menolak `undefined`.
 *
 * Unit test di atas memanggil `PcService` langsung, jadi tidak pernah melewati
 * `ValidationPipe`. Akibatnya endpoint-nya menolak request yang justru tidak
 * mengirim `alasan` — dan UI tidak pernah bisa menyalakan flag sama sekali,
 * padahal semua test hijau.
 *
 * Test ini menjalankan DTO lewat `validate()` yang sama dengan yang dipakai
 * `ValidationPipe` global, karena itu lapisan tempat bugnya tinggal.
 */
describe('SetAutoUpdatePcDto — lewat ValidationPipe', () => {
  async function validasi(body: unknown) {
    const dto = plainToInstance(SetAutoUpdatePcDto, body);
    return validate(dto);
  }

  it('tanpa alasan harus diterima — inilah yang di kirim UI', async () => {
    const e = await validasi({ ids: ['a'], aktif: true });
    expect(e).toHaveLength(0);
  });

  it('alasan kosong (string kosong) diterima', async () => {
    const e = await validasi({ ids: ['a'], aktif: true, alasan: '' });
    expect(e).toHaveLength(0);
  });

  it('alasan sampai 200 karakter diterima', async () => {
    const e = await validasi({ ids: ['a'], aktif: true, alasan: 'x'.repeat(200) });
    expect(e).toHaveLength(0);
  });

  it('alasan 201 karakter ditolak', async () => {
    const e = await validasi({ ids: ['a'], aktif: true, alasan: 'x'.repeat(201) });
    expect(e.map((x) => x.property)).toContain('alasan');
  });

  it('daftar kosong tetap ditolak', async () => {
    const e = await validasi({ ids: [], aktif: true });
    // ⚠️ Kunci constraint bukan 'message'. @ArrayNotEmpty menghasilkan constraint
    // bernama 'arrayNotEmpty', jadi x.constraints?.message selalu undefined —
    // tes ini sempat gagal bukan karena endpoint salah, tapi karena cara
    // membaca jawabannya.
    const pesan = e.flatMap((x) => Object.values(x.constraints ?? {}));
    expect(pesan).toContain('Pilih minimal satu PC');
  });

  it('aktif harus boolean, string "true" ditolak', async () => {
    const e = await validasi({ ids: ['a'], aktif: 'true' });
    expect(e.map((x) => x.property)).toContain('aktif');
  });
});
