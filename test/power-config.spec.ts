import { describe, expect, it, vi } from 'vitest';
import { SessionGateway } from '../src/session/session.gateway.js';
import { AGENT_PREVENT_SLEEP_KEY } from '../src/settings/power-keys.js';

/**
 * Tes untuk push konfigurasi daya PC ke agent (`agent:power_config`).
 *
 * Yang dijaga di sini bukan cuma "apakah event terkirim", tapi:
 *
 * 1. **Default-nya `true`.** Kalau setting belum pernah disimpan, PC warnet
 *    tetap tidak boleh tidur / mati layar / muncul screensaver. Kalau default
 *    jatuh ke `false`, PC bisa tertidur di tengah sesi pelanggan dan billing
 *    berhenti tanpa ada yang tahu.
 * 2. **`sendPowerConfigTo()` tidak boleh melempar.** Ia dipanggil di DALAM
 *    `handleConnection`, setelah socket lama PC lain diputus. Kalau melempar,
 *    agent PC tersebut tidak terdaftar sama sekali.
 * 3. **Payload-nya cuma satu boolean.** Tidak ada teks yang bisa rusak kalau
 *    di-parse agent.
 */

type Gateway = SessionGateway & {
  pcSocketMap: Map<string, string>;
  sendPowerConfigTo(pcId: string, socketId: string): Promise<void>;
  pushPowerConfig(aktif: boolean): number;
};

/** Bikin gateway dengan server palsu yang merekam semua emit. */
function buatGateway(nilaiSetting: string | null = null, akanMelempar = false) {
  const teremit: Array<{ ke: string; event: string; payload: unknown }> = [];
  const server = {
    to: (ke: string) => ({
      emit: (event: string, payload: unknown) => {
        teremit.push({ ke, event, payload });
      },
    }),
  };

  const prisma = {
    setting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        if (akanMelempar) throw new Error('database tidak terjangkau');
        if (where.key !== AGENT_PREVENT_SLEEP_KEY) return null;
        return nilaiSetting === null ? null : { key: where.key, value: nilaiSetting };
      }),
    },
  };

  const gw = new SessionGateway(
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
    {} as never,
    {} as never,
  );
  const g = gw as unknown as Gateway;
  g.server = server as never;
  g.pcSocketMap = new Map();
  return { g, teremit, prisma };
}

describe('pushPowerConfig', () => {
  it('dikirim ke SEMUA agent yang tersambung dan mengembalikan jumlahnya', () => {
    const { g, teremit } = buatGateway();
    g.pcSocketMap.set('pc-1', 'sock-1');
    g.pcSocketMap.set('pc-2', 'sock-2');

    const n = g.pushPowerConfig(true);

    expect(n).toBe(2);
    expect(teremit).toEqual([
      { ke: 'sock-1', event: 'agent:power_config', payload: { preventSleep: true } },
      { ke: 'sock-2', event: 'agent:power_config', payload: { preventSleep: true } },
    ]);
  });

  it('aktif=false dikirim apa adanya (matikan fitur)', () => {
    const { g, teremit } = buatGateway();
    g.pcSocketMap.set('pc-1', 'sock-1');

    g.pushPowerConfig(false);

    expect(teremit[0].payload).toEqual({ preventSleep: false });
  });

  it('tidak ada agent tersambung -> 0, tidak ada emit', () => {
    const { g, teremit } = buatGateway();

    expect(g.pushPowerConfig(true)).toBe(0);
    expect(teremit).toEqual([]);
  });
});

describe('sendPowerConfigTo', () => {
  it('setting belum pernah disimpan -> default TRUE', async () => {
    const { g, teremit } = buatGateway(null);

    await g.sendPowerConfigTo('pc-1', 'sock-1');

    expect(teremit[0].payload).toEqual({ preventSleep: true });
  });

  it('setting "true" -> true', async () => {
    const { g, teremit } = buatGateway('true');

    await g.sendPowerConfigTo('pc-1', 'sock-1');

    expect(teremit[0].payload).toEqual({ preventSleep: true });
  });

  it('setting "false" -> false (admin mematikannya)', async () => {
    const { g, teremit } = buatGateway('false');

    await g.sendPowerConfigTo('pc-1', 'sock-1');

    expect(teremit[0].payload).toEqual({ preventSleep: false });
  });

  it('nilai tidak sama "true" -> dianggap false', async () => {
    // Sengaja tidak menebak: hanya string "true" yang berarti aktif. Kalau
    // nilai lain ikut dianggap aktif, satu typo di database ("TRUE ", "yes")
    // akan diam-diam membuat PC tetap tidak bisa tidur.
    const { g, teremit } = buatGateway('yes');

    await g.sendPowerConfigTo('pc-1', 'sock-1');

    expect(teremit[0].payload).toEqual({ preventSleep: false });
  });

  // ⚠️ Yang paling penting. `sendPowerConfigTo()` dipanggil dari
  // `handleConnection` tepat setelah socket lama PC lain diputus. Kalau
  // melempar, agent itu tidak terdaftar sama sekali — PC berhenti online.
  it('prisma gagal -> TIDAK melempar, agent tetap terdaftar', async () => {
    const { g, teremit } = buatGateway(null, true);

    await expect(g.sendPowerConfigTo('pc-1', 'sock-1')).resolves.toBeUndefined();
    expect(teremit).toEqual([]);
  });
});
