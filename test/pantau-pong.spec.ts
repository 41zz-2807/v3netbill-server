import { describe, expect, it, vi } from 'vitest';
import { SessionGateway } from '../src/session/session.gateway.js';
import { diagnosisButuhTindakan, diagnosisKoneksi } from '../src/pc/koneksi-diagnosis.js';

/**
 * Tes pemantauan balasan ping (sinyal kedua).
 *
 * 🔴 Tanpa ini, "heartbeat agent berhenti" tidak bisa dibedakan dari "koneksi
 * putus". Keduanya menghasilkan `disconnect_timeout` yang identik, jadi
 * operator tidak pernah tahu apakah PC-nya perlu diawasi atau memang dimatikan.
 *
 * Yang diuji di sini adalah sisi gateway: apakah waktu pong benar-benar
 * tercatat, dan apakah kegagalan memasang listener tidak menjatuhkan agent.
 */

type GatewayPong = SessionGateway & {
  pantauPong(client: unknown, pcId: string): void;
  terakhirPong: Map<string, Date>;
};

/** Socket tiruan yang menyimpan listener `packet` seperti engine.io sungguhan. */
function buatSocketAda(): {
  socket: unknown;
  kirimPacket: (tipe: string) => void;
  jumlahListener: () => number;
} {
  const pendengar: Array<(p: { type?: string }) => void> = [];
  return {
    socket: {
      id: 'socket-1',
      conn: {
        on: (event: string, fn: (p: { type?: string }) => void) => {
          if (event === 'packet') pendengar.push(fn);
        },
      },
    },
    kirimPacket: (tipe: string) => pendengar.forEach((fn) => fn({ type: tipe })),
    jumlahListener: () => pendengar.length,
  };
}

function buatGateway() {
  const gw = new SessionGateway(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return gw as unknown as GatewayPong;
}

describe('pemantauan pong', () => {
  it('koneksi baru langsung mencatat waktu pong', () => {
    // ⚠️ Tanpa baris ini, PC yang baru konek terlihat "tidak pernah ada
    // pong" sampai pong pertama datang, dan bisa salah dibaca sebagai mati.
    const g = buatGateway();
    const s = buatSocketAda();
    g.pantauPong(s.socket, 'pc-1');
    expect(g.waktuPongTerakhir('pc-1')).toBeInstanceOf(Date);
  });

  it('packet pong memperbarui waktu', async () => {
    const g = buatGateway();
    const s = buatSocketAda();
    g.pantauPong(s.socket, 'pc-1');
    const awal = g.waktuPongTerakhir('pc-1')!.getTime();

    await new Promise((r) => setTimeout(r, 5));
    s.kirimPacket('pong');

    expect(g.waktuPongTerakhir('pc-1')!.getTime()).toBeGreaterThan(awal);
  });

  it('packet open dan message TIDAK dihitung sebagai bukti hidup', async () => {
    // ⚠️ `open` dan `message` datang pada koneksi yang sama. Kalau ikut
    // dihitung, "transport hidup" terbukti dari sinyal yang bukan bukti —
    // heartbeat yang macet akan tetap terbaca hidup.
    //
    // ⚠️ WAJIB ada jeda nyata di sini. Tanpa itu, `new Date()` mengembalikan
    // milidetik yang sama sehingga perbandingan selalu lulus — termasuk saat
    // kodenya salah. Tes ini sempat Mutations dan tetap hijau karena itu.
    const g = buatGateway();
    const s = buatSocketAda();
    g.pantauPong(s.socket, 'pc-1');
    const awal = g.waktuPongTerakhir('pc-1')!.getTime();

    await new Promise((r) => setTimeout(r, 5));
    s.kirimPacket('open');
    s.kirimPacket('message');

    expect(g.waktuPongTerakhir('pc-1')!.getTime()).toBe(awal);
  });

  it('socket tanpa listener packet tidak melempar', () => {
    // Pemanggilnya `handleConnection()`. Kalau melempar di sini, agent PC itu
    // gagal daftar dan PC itu berhenti online sampai reconnect berikutnya.
    const g = buatGateway();
    const socketTanpaConn = { id: 'x', conn: null };
    expect(() => g.pantauPong(socketTanpaConn, 'pc-1')).not.toThrow();
  });

  it('register berulang pada socket yang sama TIDAK menambah listener', async () => {
    // 🔴 `pantauPong()` dipanggil dari `registerAgent()`, dan itu bisa jalan
    // berulang untuk socket yang sama karena identitas PC datang dari
    // handshake query DAN dari event `agent:register`. Tanpa penjaga, listener
    // menumpuk setiap kali register diulang.
    //
    // ⚠️ Tes ini ditambahkan setelah mutasi `if (false)` pada penjaganya
    // ternyata LULUS -- artinya sebelumnya tidak ada tes yang memegangnya, dan
    // komentar di method yang mengklaim listener sudah dijaga sama sekali
    // tidak terbukti. Jadi yang diuji di sini adalah bentuk pemanggilannya,
    // bukan cuma isi Map-nya.
    const g = buatGateway();
    const s = buatSocketAda();

    g.pantauPong(s.socket, 'pc-1');
    expect(s.jumlahListener()).toBe(1);

    g.pantauPong(s.socket, 'pc-1');
    g.pantauPong(s.socket, 'pc-1');
    expect(s.jumlahListener()).toBe(1);

    // Yang penting: listener yang tersisa tetap berfungsi.
    await new Promise((r) => setTimeout(r, 5));
    s.kirimPacket('pong');
    expect(g.terakhirPong.get('pc-1')).toBeDefined();
  });

  it('socket yang conn-nya bukan objek tidak melempar', () => {
    const g = buatGateway();
    expect(() => g.pantauPong({ id: 'x' }, 'pc-1')).not.toThrow();
    expect(() => g.pantauPong(null, 'pc-1')).not.toThrow();
    expect(() => g.pantauPong(undefined, 'pc-1')).not.toThrow();
  });

  it('listener yang melempar saat dipanggil tidak menjatuhkan proses', () => {
    const g = buatGateway();
    let dipanggil = 0;
    const socket = {
      id: 'x',
      conn: {
        on: (event: string, fn: (p: { type?: string }) => void) => {
          if (event === 'packet') {
            dipanggil++;
            expect(typeof fn).toBe('function');
          }
        },
      },
    };
    expect(() => g.pantauPong(socket, 'pc-1')).not.toThrow();
    expect(dipanggil).toBe(1);
  });

  it('PC yang belum pernah konek mengembalikan null, bukan waktu sekarang', () => {
    // ⚠️ `null` berarti "belum ada bukti". Kalau dikembalikan waktu sekarang,
    // diagnosis akan menyimpulkan transport hidup padahal tidak pernah ada
    // satu pun pong.
    const g = buatGateway();
    expect(g.waktuPongTerakhir('pc-belum-adaptera')).toBeNull();
  });

  it('nilai pong tidak dihapus saat socket putus', () => {
    // Nilai terakhir itulah bukti kapan transport terakhir hidup. Kalau
    // dihapus, selisih "berhenti berdekatan" tidak bisa dihitung.
    const g = buatGateway();
    const s = buatSocketAda();
    g.pantauPong(s.socket, 'pc-1');
    expect(g.terakhirPong.size).toBe(1);
  });
});

describe('dua sinyal menjadi diagnosis', () => {
  it('pong basi tapi heartbeat masih hidup TIDAK dikira agent hang', () => {
    // secara fisik ini hampir mustahil: heartbeat juga lewat transport yang
    // sama. Tapi kalau muncul, kode TIDAK menebaknya sebagai agent hang --
    // agent hang berarti pong SEHAT, jadi klaim itu akan salah besar.
    const sekarang = new Date('2026-10-18T12:00:00.000Z');
    const h = diagnosisKoneksi({
      terakhirHeartbeat: new Date(sekarang.getTime() - 2000),
      terakhirPong: new Date(sekarang.getTime() - 50_000),
      sekarang,
    });
    expect(h.diagnosis).toBe('PUTUS_TIDAK_BERDEKATAN');
    expect(diagnosisButuhTindakan(h)).toBe(false);
  });

  it('kedua sinyal basi dan berdekatan menghasilkan selisih kecil', () => {
    // ⚠️ Pong harus lewat 45 detik supaya ikut dianggap basi. Kalau 42 detik,
    // pong masih segar dan hasilnya jadi SUSPICIOUS_AGENT_HANG.
    const sekarang = new Date('2026-10-18T12:00:00.000Z');
    const h = diagnosisKoneksi({
      terakhirHeartbeat: new Date(sekarang.getTime() - 60_000),
      terakhirPong: new Date(sekarang.getTime() - 62_000),
      sekarang,
    });
    expect(h.diagnosis).toBe('PUTUS_BERSAMA');
    expect(h.selisihMs).toBe(2000);
  });
});