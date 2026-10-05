import { describe, expect, it, vi } from 'vitest';
import { PcStatus, SessionStatus } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { PcService } from '../src/pc/pc.service.js';

/**
 * Tes untuk `PcService.setRusak()` dan pengaman hapus PC yang ditandai.
 *
 * ⚠️ Dua hal yang diuji di sini adalah tempat paling rawan salah:
 *
 * 1. **Urutan di `setRusak()`**. Sesi harus dihentikan SEBELUM flag ditulis.
 *    Kalau dibalik, ada celah detik-detik PC sudah ditandai tapi sesinya masih
 *    jalan — dan dashboard sudah menyingkirkannya, jadi kasir tidak pernah
 *    melihat sesi yang masih berjalan itu.
 *
 * 2. **`remove()` menolak PC yang ditandai**. Menghapus PC menghapus sesinya
 *    dengan `deleteMany`, jadi seluruh riwayat transaksinya hilang permanen.
 *    PC rusak justru PC yang paling mungkin perlu ditelusuri ulang.
 */

type PcRow = {
  id: string;
  namaPc: string;
  ipClient: string;
  status: PcStatus;
  lastHeartbeatAt: Date | null;
  agentToken: string;
  rusak: boolean;
  alasanRusak: string | null;
};

const pcRow = (): PcRow => ({
  id: 'pc-1',
  namaPc: 'PC001',
  ipClient: '',
  status: PcStatus.IDLE,
  lastHeartbeatAt: new Date(),
  agentToken: 'token-rahasia',
  rusak: false,
  alasanRusak: null,
});

function harness(pc: PcRow, sesiAda: boolean) {
  const jejak: string[] = [];
  let barisPc = pc;

  const logBilling = {
    invalidateNamaPc: vi.fn(),
  };
  const sessionService = {
    stopSession: vi.fn(async (sessionId: string, alasan: string) => {
      jejak.push(`stopSession(${sessionId},${alasan})`);
    }),
    kunciLayarPc: vi.fn(async (pcId: string) => {
      jejak.push(`kunciLayarPc(${pcId})`);
    }),
    broadcastPcUpdate: vi.fn(async () => {
      jejak.push('broadcastPcUpdate');
    }),
  };

  const prisma = {
    pc: {
      findUnique: async (args?: { include?: { sessions?: unknown } }) => {
        // `remove()` memakai `include: { sessions }`, sedangkan `setRusak()`
        // tidak. Keduanya harus dilayani mock yang sama.
        if (args?.include?.sessions) {
          return {
            ...barisPc,
            sessions: sesiAda ? [{ id: 'sesi-1', status: SessionStatus.BERJALAN }] : [],
          };
        }
        return barisPc;
      },
      findMany: async (args?: { where?: { rusak?: boolean } }) => {
        jejak.push('pc.findMany');
        if (args?.where?.rusak === false) {
          return barisPc.rusak ? [] : [barisPc];
        }
        return [barisPc];
      },
      update: async (args: { data: { rusak: boolean; alasanRusak: string | null } }) => {
        jejak.push(`pc.update(rusak=${args.data.rusak})`);
        barisPc = { ...barisPc, ...args.data };
        return { id: barisPc.id, namaPc: barisPc.namaPc, rusak: barisPc.rusak };
      },
      delete: async () => {
        jejak.push('pc.delete');
        return barisPc;
      },
    },
    session: {
      findFirst: async () => {
        jejak.push('session.findFirst');
        return sesiAda
          ? { id: 'sesi-1', status: SessionStatus.BERJALAN }
          : null;
      },
      findMany: async () => (sesiAda ? [{ pcId: pc.id, status: SessionStatus.BERJALAN }] : []),
      deleteMany: async () => {
        jejak.push('session.deleteMany');
        return { count: 0 };
      },
    },
    $transaction: async (arr: unknown[]) => {
      jejak.push('$transaction');
      return arr;
    },
  };

  const svc = new PcService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logBilling as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionService as any,
  );

  return { svc, jejak, dapatPc: () => barisPc, logBilling, sessionService };
}

describe('PcService.setRusak', () => {
  it('menandai rusak: sesi dihentikan, layar dikunci, lalu flag ditulis', async () => {
    const { svc, jejak, dapatPc } = harness(pcRow(), true);

    const hasil = await svc.setRusak('pc-1', { rusak: true, alasan: 'ganti hard disk' });

    expect(hasil.rusak).toBe(true);
    expect(hasil.sesiDihentikan).toBe(true);
    expect(dapatPc().alasanRusak).toBe('ganti hard disk');

    // ⚠️ Urutan ini yang dijaga. Sesi berhenti dulu, layar dikunci, baru flag.
    expect(jejak).toEqual([
      'session.findFirst',
      'stopSession(sesi-1,manual)',
      'kunciLayarPc(pc-1)',
      'pc.update(rusak=true)',
      'broadcastPcUpdate',
    ]);
  });

  it('alasan kosong/spasi saja disimpan sebagai null, bukan string kosong', async () => {
    const { svc, dapatPc } = harness(pcRow(), false);

    await svc.setRusak('pc-1', { rusak: true, alasan: '   ' });

    expect(dapatPc().alasanRusak).toBeNull();
  });

  it('matikan flag: sesi TIDAK dihentikan dan alasan dikosongkan', async () => {
    const pc = { ...pcRow(), rusak: true, alasanRusak: 'mouse rusak' };
    const { svc, jejak, dapatPc, sessionService } = harness(pc, false);

    const hasil = await svc.setRusak('pc-1', { rusak: false });

    expect(hasil.rusak).toBe(false);
    expect(hasil.sesiDihentikan).toBe(false);
    expect(dapatPc().alasanRusak).toBeNull();
    // Layar tidak dikunci — PC justru harus bisa dipakai lagi.
    expect(sessionService.kunciLayarPc).not.toHaveBeenCalled();
    expect(sessionService.stopSession).not.toHaveBeenCalled();
    expect(jejak).not.toContain('session.findFirst');
  });

  it('PC tidak ada -> 404, tidak diam-diam berhasil', async () => {
    const { svc } = harness(pcRow(), false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).prisma.pc.findUnique = async () => null;

    await expect(svc.setRusak('pc-hantu', { rusak: true })).rejects.toThrow('PC not found');
  });

  it('menandai PC tanpa sesi: tidak ada stopSession, tapi layar tetap dikunci', async () => {
    const { svc, jejak } = harness(pcRow(), false);

    const hasil = await svc.setRusak('pc-1', { rusak: true });

    expect(hasil.sesiDihentikan).toBe(false);
    expect(jejak).not.toContain('stopSession(sesi-1,manual)');
    expect(jejak).toContain('kunciLayarPc(pc-1)');
  });
});

describe('PcService.remove menolak PC yang ditandai rusak', () => {
  it('PC rusak -> 409, tidak ada data yang dihapus', async () => {
    const pc = { ...pcRow(), rusak: true };
    const { svc, jejak } = harness(pc, false);

    await expect(svc.remove('pc-1')).rejects.toThrow(ConflictException);
    // ⚠️ Yang dibuktikan bukan hanya "lempar error", tapi TIDAK ADA yang dihapus.
    expect(jejak).not.toContain('session.deleteMany');
    expect(jejak).not.toContain('pc.delete');
  });

  it('PC normal tetap bisa dihapus', async () => {
    const { svc, jejak } = harness(pcRow(), false);

    await svc.remove('pc-1');

    expect(jejak).toContain('session.deleteMany');
    expect(jejak).toContain('pc.delete');
  });

  it('PC rusak DAN sedang dipakai sesi -> 409 lebih dulu, bukan 400 sesi aktif', async () => {
    // Urutan pemeriksaan penting: kalau dicek bolak-balik, kasir melihat pesan
    // "stop billing dulu" padahal masalahnya PC-nya sedang ditandai.
    const pc = { ...pcRow(), rusak: true };
    const { svc } = harness(pc, true);

    await expect(svc.remove('pc-1')).rejects.toThrow(ConflictException);
  });
});

describe('PcService.findAll menyaring sesuai IncludingRusak', () => {
  it('default (mobile) menyembunyikan PC yang ditandai rusak', async () => {
    const pc = { ...pcRow(), rusak: true };
    const { svc } = harness(pc, false);

    expect(await svc.findAll()).toEqual([]);
  });

  it('termasukRusak (Halaman PC) tetap mengirimnya', async () => {
    const pc = { ...pcRow(), rusak: true, alasanRusak: 'ganti hard disk' };
    const { svc } = harness(pc, false);

    const hasil = await svc.findAll(true);

    expect(hasil).toHaveLength(1);
    expect(hasil[0].rusak).toBe(true);
    expect(hasil[0].alasanRusak).toBe('ganti hard disk');
  });
});
