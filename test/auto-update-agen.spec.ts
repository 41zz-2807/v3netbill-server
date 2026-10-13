import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../src/settings/settings.service.js';

/**
 * Tes untuk `cekPembaruanUntukAgent()`.
 *
 * Endpoint ini dipakai AGENT, bukan operator, jadi TIDAK ada JWT. Identitasnya
 * cuma `pcId` + `agentToken`, dan `agentToken` itu cukup untuk menjalankan
 * `client:create_password` (mengganti password orang lain) serta
 * `client:stop_session`.
 *
 * Dua hal yang paling mudah salah di sini:
 *
 * 1. **Token asing harus ditolak dengan 401, bukan dibalas "tidak ada
 *    pembaruan".** Kalau balasannya sama untuk token sah dan token asing,
 *    penyerang bisa memetakan token mana yang berlaku hanya dengan
 *    mengamati bedanya.
 * 2. **`autoUpdate` default-nya FALSE.** Agent produksi yang sudah terpasang
 *    tidak punya kode ini, dan yang nanti terpasang pun tidak boleh bergerak
 *    sampai operator sengaja menyalakan sakelarnya.
 */
function buatService(opsi: {
  pc?: { id: string; agentToken: string } | null;
  installer?: string | null;
  autoUpdate?: string | null;
}) {
  const prisma = {
    pc: { findUnique: vi.fn(async () => opsi.pc ?? null) },
    setting: {
      // Dipakai patchValue() -> set() -> upsert.
      upsert: vi.fn(async () => ({})),
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        if (where.key === 'installer_meta') {
          return opsi.installer === null || opsi.installer === undefined
            ? null
            : { value: opsi.installer };
        }
        if (where.key === 'agent_auto_update') {
          return opsi.autoUpdate === null || opsi.autoUpdate === undefined
            ? null
            : { value: opsi.autoUpdate };
        }
        return null;
      }),
    },
  };

  const pushAutoUpdateConfig = vi.fn(() => 0);
  const svc = new SettingsService(
    prisma as never,
    { addCronJob: vi.fn(), getCronJobs: () => new Map() } as never,
    { catat: vi.fn() } as never,
    { pushPowerConfig: vi.fn(() => 0), pushAutoUpdateConfig } as never,
  );
  return { svc, prisma, pushAutoUpdateConfig };
}

const PC = { id: 'pc-1', agentToken: 'token-sah' };

/** Metadata installer seperti yang ditulis `saveInstaller()`. */
const META = JSON.stringify({
  filename: 'installer-1.msi',
  sizeBytes: 88952753,
  uploadedAt: '2026-10-12T00:00:00.000Z',
  versionName: '1.0.26.0',
  sha256: 'abc123',
});

describe('cekPembaruanUntukAgent', () => {
  it('agentToken salah -> Unauthorized, BUKAN "tidak ada pembaruan"', async () => {
    const { svc } = buatService({ pc: PC, installer: META, autoUpdate: 'true' });

    await expect(
      svc.cekPembaruanUntukAgent('pc-1', 'token-salah'),
    ).rejects.toThrow('agentToken PC tidak valid');
  });

  it('pcId tidak dikenal -> Unauthorized', async () => {
    const { svc } = buatService({ pc: null, installer: META, autoUpdate: 'true' });

    await expect(
      svc.cekPembaruanUntukAgent('pc-hantu', 'token-sah'),
    ).rejects.toThrow('agentToken PC tidak valid');
  });

  it('agentToken kosong -> Unauthorized', async () => {
    const { svc } = buatService({ pc: PC, installer: META, autoUpdate: 'true' });

    await expect(svc.cekPembaruanUntukAgent('pc-1', '')).rejects.toThrow(
      'agentToken PC tidak valid',
    );
  });

  it('setting belum pernah disimpan -> autoUpdate FALSE', async () => {
    const { svc } = buatService({ pc: PC, installer: META, autoUpdate: null });

    const hasil = await svc.cekPembaruanUntukAgent('pc-1', 'token-sah');

    expect(hasil.autoUpdate).toBe(false);
  });

  // `ada` sengaja tetap true walau sakelar mati: agent boleh TAHU ada versi
  // baru (itu informatif), dia cuma tidak diberi izin memasang. Kalau
  // disembunyikan, dashboard Settings dan agent terlihat tidak sinkron dan
  // operator mengira upload MSI-nya gagal.
  it('sakelar mati tapi MSI ada -> versi tetap dilaporkan', async () => {
    const { svc } = buatService({ pc: PC, installer: META, autoUpdate: 'false' });

    const hasil = await svc.cekPembaruanUntukAgent('pc-1', 'token-sah');

    expect(hasil.autoUpdate).toBe(false);
    expect(hasil.ada).toBe(true);
    expect(hasil.versi).toBe('1.0.26.0');
    expect(hasil.sha256).toBe('abc123');
    expect(hasil.ukuranBytes).toBe(88952753);
  });

  it('sakelar nyala -> autoUpdate true', async () => {
    const { svc } = buatService({ pc: PC, installer: META, autoUpdate: 'true' });

    expect((await svc.cekPembaruanUntukAgent('pc-1', 'token-sah')).autoUpdate).toBe(true);
  });

  // ⚠️ Yang SEBENARNYA ditolak adalah nilai yang ambigu, bukan huruf besar.
  // "TRUE" jelas bermaksud nyala — menolaknya cuma membingungkan operator.
  // Yang berbahaya justru "yes" / "1" / "on": satu tebakan salah di database
  // menyalakan updater di seluruh PC tanpa operator meminta.
  it('nilai ambigu ditolak (yes / 1 / on / kosong)', async () => {
    for (const nilai of ['yes', 'YA', '1', 'on', 'false', '', 'null']) {
      const { svc } = buatService({ pc: PC, installer: META, autoUpdate: nilai });
      const hasil = await svc.cekPembaruanUntukAgent('pc-1', 'token-sah');
      expect(hasil.autoUpdate, `nilai "${nilai}"`).toBe(false);
    }
  });

  it('huruf besar "TRUE" tetap dianggap nyala', async () => {
    const { svc } = buatService({ pc: PC, installer: META, autoUpdate: 'TRUE' });

    expect((await svc.cekPembaruanUntukAgent('pc-1', 'token-sah')).autoUpdate).toBe(true);
  });

  it('belum ada MSI -> ada false, versi null, hash null', async () => {
    const { svc } = buatService({ pc: PC, installer: null, autoUpdate: 'true' });

    const hasil = await svc.cekPembaruanUntukAgent('pc-1', 'token-sah');

    expect(hasil.ada).toBe(false);
    expect(hasil.versi).toBeNull();
    expect(hasil.sha256).toBeNull();
  });

  it('installer_meta rusak -> bukan crash, tapi tetap ditolak di sisi agent', async () => {
    const { svc } = buatService({
      pc: PC,
      installer: '{bukan json',
      autoUpdate: 'true',
    });

    // getInstallerMeta() menelan JSON rusak dan mengembalikan null.
    const hasil = await svc.cekPembaruanUntukAgent('pc-1', 'token-sah');
    expect(hasil.ada).toBe(false);
    expect(hasil.versi).toBeNull();
  });
});

describe('patchValue untuk agent_auto_update', () => {
  it('menyimpan lalu mendorong ke agent yang tersambung', async () => {
    const { svc, pushAutoUpdateConfig } = buatService({
      pc: PC,
      installer: META,
      autoUpdate: 'true',
    });

    await svc.patchValue('agent_auto_update', 'true');

    expect(pushAutoUpdateConfig).toHaveBeenCalledWith(true);
  });

  it('nilai non-"true" juga dorong sebagai false', async () => {
    const { svc, pushAutoUpdateConfig } = buatService({
      pc: PC,
      installer: META,
      autoUpdate: 'false',
    });

    await svc.patchValue('agent_auto_update', 'false');

    expect(pushAutoUpdateConfig).toHaveBeenCalledWith(false);
  });

  it('key lain TIDAK memicu push auto-update', async () => {
    const { svc, pushAutoUpdateConfig } = buatService({
      pc: PC,
      installer: META,
      autoUpdate: 'true',
    });

    await svc.patchValue('harga_per_menit', '150');

    expect(pushAutoUpdateConfig).not.toHaveBeenCalled();
  });
});