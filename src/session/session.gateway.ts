import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { isIP } from 'node:net';
import { SessionService, SessionGatewayEvents } from './session.service.js';
import { JwtService } from '@nestjs/jwt';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Role, AccountType } from '@prisma/client';
import { ActivityLogService } from '../activity-log/activity-log.service.js';
import { NotifikasiService } from '../notifikasi/notifikasi.service.js';
import { LogBillingService } from '../log-billing/log-billing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TeknisiService } from './teknisi.service.js';
import { OTP_BOT_TOKEN_KEY, OTP_CHAT_ID_KEY } from '../settings/otp-keys.js';
import {
  NEXTCLOUD_URL_KEY,
  NEXTCLOUD_USER_KEY,
  NEXTCLOUD_PASSWORD_KEY,
  NEXTCLOUD_FOLDER_KEY,
  NEXTCLOUD_FOLDER_BAVAAN,
} from '../settings/nextcloud-keys.js';
import { BYPASS_PIN_HASH_KEY } from '../settings/bypass-keys.js';

/** Kunci Setting Nextcloud, dipakai untuk query `sendNextcloudConfigTo`. */
const NEXTCLOUD_KEYS_DI_GATEWAY = [
  NEXTCLOUD_URL_KEY,
  NEXTCLOUD_USER_KEY,
  NEXTCLOUD_PASSWORD_KEY,
  NEXTCLOUD_FOLDER_KEY,
];

/**
 * Durasi yang dikirim ke agent saat teknisi login.
 *
 * ⚠️ Angka ini TIDAK adalah waktu yang dibeli — tidak ada tagihan, tidak ada
 * `Account`, tidak ada sisa waktu yang berkurang di database. Agent memakai
 * `SisaDetik` hanya sebagai syarat "layar kunci terbuka" (`SisaDetik > 0`),
 * jadi angkanya hanya perlu cukup besar supaya tidak pernah menyentuh nol
 * selama perbaikan. Bisa diperkecil tanpa efek ke billing, tapi jangan diubah
 * tanpa alasan: kalau terlalu kecil, PC teknisi terkunci sendiri di tengah
 * perbaikan.
 */
const DURASI_TEKNISI_DETIK = 12 * 60 * 60; // 12 jam

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/session',
})
export class SessionGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, SessionGatewayEvents {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SessionGateway.name);
  private pcSocketMap: Map<string, string> = new Map(); // pcId -> socketId
  private socketPcMap: Map<string, string> = new Map(); // socketId -> pcId
  private dashboardSockets: Set<string> = new Set();

  constructor(
    private sessionService: SessionService,
    private jwtService: JwtService,
    private activityLogService: ActivityLogService,
    private prisma: PrismaService,
    private notifikasiService: NotifikasiService,
    private logBilling: LogBillingService,
    /**
     * Opsional supaya tes lama yang memanggil `new SessionGateway(...)` dengan
     * enam argumen tidak ikut patah. Tanpa service ini, `cobaLoginTeknisi()`
     * selalu mengembalikan `false` dan perilakunya persis seperti sebelum
     * fitur ini ada.
     */
    private teknisiService?: TeknisiService,
  ) {}

  afterInit(server: Server): void {
    this.logger.log('SessionGateway initialized');
    // ⚠️ WAJIB `.catch()`. `setGatewayEvents()` mengembalikan Promise (karena
    // di dalamnya ada recovery sesi), dan `afterInit` tidak bisa `await`.
    // Promise yang ditelantarkan tanpa catch menjadi unhandled rejection —
    // dan Node 20 **menjatuhkan seluruh proses** kalau itu terjadi saat
    // startup. Akibatnya satu query Prisma yang gagal di sini berarti
    // seluruh backend tidak start, dan tidak ada satu PC pun yang bisa billing.
    //
    // `recoverRunningSessions()` sudah punya try/catch sendiri, jadi catch di
    // bawah ini adalah jaring kedua, bukan jaring utama.
    this.sessionService.setGatewayEvents(this).catch((err: unknown) => {
      const pesan = err instanceof Error ? err.message : String(err);
      this.logger.error(`setGatewayEvents gagal: ${pesan}`);
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Client connected: ${client.id}`);

    // Dashboard login: verifikasi JWT di handshake auth → simpan role + userId + username.
    // `username` wajib disimpan supaya aktivitas (kunci/matikan PC) bisa dicatat
    // atas nama orangnya, bukan hanya role.
    const authToken = (client.handshake.auth as { token?: string } | undefined)?.token;
    if (authToken) {
      try {
        const payload = await this.jwtService.verifyAsync<{ role: Role; sub?: string; username?: string }>(authToken);
        if (payload.role === Role.ADMIN || payload.role === Role.KASIR) {
          client.data.role = payload.role;
          client.data.userId = payload.sub;
          client.data.username = payload.username;
        }
      } catch {
        client.data.role = undefined;
        client.data.userId = undefined;
        client.data.username = undefined;
      }
    }

    const pcId = client.handshake.query?.pcId;
    const agentToken = client.handshake.query?.agentToken;
    if (typeof pcId === 'string' && typeof agentToken === 'string') {
      await this.registerAgent(client, pcId, agentToken);
    } else {
      this.logger.warn(`Connection ${client.id} tanpa pcId/agentToken di handshake query — tidak didaftarkan ke map`);
    }

    if (this.dashboardSockets.size > 0) {
      const data = await this.sessionService.getDashboardData();
      this.server.to('dashboard').emit('dashboard:pc_update', { pcs: data });
    }
  }

  /**
   * Kirim ulang `session:start` ke agent yang baru (re)connect, kalau PC itu
   * sedang punya sesi berjalan.
   *
   * ⚠️ Ini menutup celah yang TIDAK bisa ditutup dari sisi agent: `_currentState`
   * di `Worker.cs` diinisialisasi `Locked`, dan tidak ada permintaan state ke
   * server dari sisi agent (agent hanya kirim `agent:register` +
   * `agent:heartbeat`). Jadi kalau Windows service di PC klien restart
   * sementara ada sesi berjalan, layar PC kembali ke form login sementara
   * server masih terus menagih — pelanggan bisa melihat layar login di PC
   * yang sedang ditagih, atau menekan login dan ditolak
   * "PC sudah memiliki sesi berjalan".
   *
   * Kenapa TIDAK perlu install MSI baru: handler yang menerimanya sudah ada di
   * versi yang terpasang (1.0.17.0) dan keduanya idempoten —
   * `Worker.OnSessionStarted` hanya menimpa field state lalu mengirim ulang
   * StateUpdate + label akun, dan `Overlay.ApplySessionStarted` hanya menimpa
   * label akun. Tidak ada penghitung, dialog, atau proses yang di-spawn. Itu
   * penting karena fungsi ini jalan di SETIAP konek, termasuk kasus biasa
   * server restart di tengah pelanggan main.
   *
   * ⚠️ WAJIB dibungkus `try/catch` dan TIDAK boleh melempar. Pemanggilnya
   * `registerAgent()`; kalau di sini gagal, agent PC itu tidak boleh gagal
   * daftar — dan `registerAgent()` juga mendayangkan socket lama milik PC lain
   * tepat sebelum pemanggilan ini.
   */
  private async kirimUlangSesiKeAgent(pcId: string): Promise<void> {
    try {
      const sesi = await this.sessionService.sesiBerjalanUntukAgent(pcId);
      if (!sesi) {
        return;
      }
      this.emitSessionStart(pcId, sesi.sessionId, sesi.sisaDetik, sesi.akun);
      this.logger.log(
        `Sesi berjalan dikirim ulang ke agent ${pcId} (sessionId=${sesi.sessionId}, sisa=${sesi.sisaDetik}detik)`,
      );
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      // Level warn, bukan error: agent tetap terdaftar dan tetap jalan, hanya
      // tidak menerima info sesi sampai tick berikutnya (maksimal 1 detik).
      this.logger.warn(`Gagal mengirim ulang sesi ke agent ${pcId}: ${pesan}`);
    }
  }

  /**
   * Coba login teknisi. Mengembalikan `true` kalau request ini memang
   * untuk teknisi (berhasil atau ditolak) — jadi pemanggil tahu jangan
   * melanjutkan ke login akun pelanggan.
   *
   * ⚠️ Definisi "request untuk teknisi" harus BEDA dari "kode teknisi benar".
   * Kalau kode tidak cocok dengan akun teknisi, fungsi ini mengembalikan
   * `false` dan login diteruskan sebagai akun pelanggan — supaya kode yang
   * kebetulan sama tidak membuat dua meanings.
   *
   * Kenapa tidak membuat baris `Session`: `Session.accountId` punya FK
   * `RESTRICT` yang tidak boleh null, dan `Session` ikut dihitung sebagai
   * `totalLogin` di laporan harian. Yang perlu dari server hanyalah "PC ini
   * sedang dipakai teknisi" — cukup satu baris di `SesiTeknisi`.
   */
  private async cobaLoginTeknisi(
    pcId: string,
    kredensial: { kode?: string; kodeUnik?: string; nama?: string; password: string },
  ): Promise<boolean> {
    const kode = (kredensial.kode ?? kredensial.kodeUnik ?? kredensial.nama ?? '').trim();
    if (!kode) {
      return false;
    }

    // Cheap filter dulu: hanya username teknisi yang sedang tried. Tanpa ini
    // setiap login pelanggan akan kena satu query bcrypt.
    const namaTeknisi = await this.teknisiService?.namaTeknisiAktif();
    if (!namaTeknisi || !namaTeknisi.includes(kode)) {
      return false;
    }

    const hasil = await this.teknisiService!.verifikasiLogin(kode, kredensial.password);
    if (!hasil) {
      // ⚠️ Balasan WAJIB dikirim, kalau tidak kartu login di PC hanya diam dan
      // teknisi menekan tombol berulang tanpa tahu kenapa.
      //
      // Pesannya PERSIS sama dengan yang muncul untuk akun biasa yang tidak
      // ketemu. Kalau "kode dikenal tapi PIN salah" dibedakan dari "kode tidak
      // dikenal", orang yang menebak di PC client bisa memetakan kode teknisi
      // mana yang terdaftar — dan kode itu sudah setengah dari kredensial.
      this.logger.warn(`Login teknisi ditolak di PC ${pcId}`);
      this.emitLoginGagal(pcId, 'Akun tidak ditemukan');
      return true;
    }

    // PC sedang dipakai -> tolak. Kalau tidak, ada dua orang dalam satu PC:
    // pelanggan yang ditagih dan teknisi yang membongkar.
    const sesiBerjalan = await this.sessionService.sesiBerjalanId(pcId);
    if (sesiBerjalan) {
      this.logger.warn(`Login teknisi ditolak di PC ${pcId}: ada sesi pelanggan berjalan`);
      this.emitLoginGagal(pcId, 'PC sedang dipakai');
      return true;
    }

    // PC ditandai rusak tidak boleh dipakai, sama seperti akun biasa. Tanpa
    // cek ini teknisi bisa membuka PC yang sengaja disingkirkan dari dashboard.
    const pc = await this.prisma.pc.findUnique({
      where: { id: pcId },
      select: { rusak: true },
    });
    if (!pc || pc.rusak) {
      this.logger.warn(`Login teknisi ditolak di PC ${pcId}: PC ditandai rusak`);
      this.emitLoginGagal(pcId, 'PC sedang tidak tersedia');
      return true;
    }

    // Bersihkan sisa sesi teknisi lama di PC ini supaya tidak ada dua baris
    // terbuka (mis. teknisi sebelumnya keluar tanpa sempat logout).
    await this.teknisiService!.selesaiSesi(pcId);
    await this.teknisiService!.mulaiSesi(pcId, hasil.username);

    this.logger.log(`TEKNISI ${hasil.username} login di PC ${pcId}`);

    const sessionId = `teknisi-${Date.now()}`;
    // ⚠️ `client:login_result` WAJIB dikirim, sama seperti login akun biasa.
    // Worker meneruskannya ke overlay, dan `HandleLoginResult` yang saat sukses
    // itu yang memanggil `RequestStateAsync()` serta menyembunyikan teks galat
    // di kartu login. Tanpa baris ini, overlay sudah terbuka tapi kartu login
    // masih menampilkan sisa pesan "gagal" dari percobaan sebelumnya.
    const socketId = this.pcSocketMap.get(pcId);
    if (socketId) {
      this.server.to(socketId).emit('client:login_result', { success: true, sessionId });
    }

    // Dipakai `session:start` supaya overlay terbuka (syaratnya
    // `SisaDetik > 0` di MainWindow.xaml.cs), TAPI tidak lewat
    // `sessionService.loginRequest()` — jadi tidak ada `Session` di database.
    // `sessionId` sintetis karena tidak ada baris Session sebagai rujukan.
    this.emitSessionStart(pcId, sessionId, DURASI_TEKNISI_DETIK, {
      kodeUnik: null,
      nama: `Teknisi ${hasil.username}`,
      tipe: 'MEMBER',
    });
    this.broadcastActivityLog('teknisi:login', {
      pcId,
      teknisi: hasil.username,
      keterangan: `login teknisi ${hasil.username}`,
    });
    await this.broadcastPcUpdate();
    return true;
  }

  /**
   * Kunci setiap PC yang sedang dipakai teknisi.
   *
   * ⚠️ Dipakai saat sakelar akses teknisi dimatikan. Menolak login baru saja
   * TIDAK cukup: kalau PIN bocor, teknisi yang sedang di dalam PC harus
   * dikeluarkan sekarang juga, bukan nanti.
   *
   * Pakai `admin:lock`, bukan `session:stop`. Perbedaannya penting:
   * `admin:lock` hanya mengunci layar di sisi agent dan tidak menyentuh
   * database — persis yang dibutuhkan, karena sesi teknisi memang tidak pernah
   * ada baris `Session` untuk dihentikan.
   *
   * ⚠️ Daftar PC harus diteruskan dari pemanggil. Versi pertama mencarinya sendiri
   * lewat `semuaSesiAktif()`, padahal `setAktif()` sudah menutup sesi lebih
   * dulu — hasilnya nol PC terkunci tanpa satu pun error.
   *
   * Mengembalikan berapa PC yang benar-benar terkunci. PC yang agentnya offline
   * tidak bisa dikunci dan TIDAK dihitung, supaya angkanya tidak berbohong.
   */
  async kunciSemuaPcTeknisi(pcIds: string[]): Promise<number> {
    return this.kunciSebagianPcTeknisi(pcIds);
  }

  /**
   * Kunci daftar PC tertentu dengan alasan teknisi.
   *
   * Dipisah dari `kunciSemuaPcTeknisi()` karena pemanggilnya sudah punya
   * daftarnya sendiri: saat sakelar dimatikan, daftarnya dari `setAktif()`;
   * saat akun dihapus, daftarnya hanya PC milik teknisi itu. Duplikasi logika
   * penguncian di dua tempat berisikootiPrices Behaviour berbeda.
   */
  async kunciSebagianPcTeknisi(pcIds: string[]): Promise<number> {
    try {
      if (pcIds.length === 0) {
        return 0;
      }
      let terkunci = 0;
      for (const pcId of pcIds) {
        const socketId = this.pcSocketMap.get(pcId);
        if (!socketId) {
          this.logger.warn(
            `PC teknisi ${pcId} tidak bisa dikunci: agent tidak tersambung. ` +
              'PC itu akan terkunci sendiri saat layarnya disentuh.',
          );
          continue;
        }
        this.server.to(socketId).emit('admin:lock', { pcId });
        terkunci++;
        this.logger.log(`PC ${pcId} dikunci karena akses teknisi ditutup`);
      }
      return terkunci;
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.error(`Gagal mengunci PC teknisi: ${pesan}`);
      return 0;
    }
  }

  private emitLoginGagal(pcId: string, pesan: string): void {
    const socketId = this.pcSocketMap.get(pcId);
    if (socketId) {
      this.server.to(socketId).emit('client:login_result', { success: false, message: pesan });
    }
  }

  private async registerAgent(client: Socket, pcId: string, agentToken: string): Promise<boolean> {
    const isValid = await this.sessionService.validateAgentToken(pcId, agentToken);
    if (!isValid) {
      this.logger.warn(`Invalid agentToken untuk PC ${pcId} (socket ${client.id})`);
      return false;
    }

    // Satu koneksi bisa mencapai sini DUA kali: agent menaruh pcId/agentToken
    // di handshake query (dipakai handleConnection) DAN mengirim event
    // agent:register. Tanpa penjaga ini tiap koneksi menulis lastHeartbeatAt
    // dua kali, mendorong pc_update dua kali, dan mengirim config OTP/PIN
    // bypass dua kali ke socket yang sama.
    if (this.socketPcMap.get(client.id) === pcId) {
      return true;
    }

    const existingSocket = this.pcSocketMap.get(pcId);
    if (existingSocket && existingSocket !== client.id) {
      this.server.in(existingSocket).disconnectSockets(true);
      this.pcSocketMap.delete(pcId);
      this.socketPcMap.delete(existingSocket);
    }
    this.pcSocketMap.set(pcId, client.id);
    this.socketPcMap.set(client.id, pcId);

    // IP diamati dari koneksi socket (bukan diisi manual admin) supaya tetap
    // akurat walau PC klien memakai DHCP dan IP-nya berganti.
    const ipTerlihat = this.alamatIp(client);
    await this.sessionService.registerPc(pcId, ipTerlihat);
    await this.kirimUlangSesiKeAgent(pcId);
    await this.broadcastPcUpdate();

    this.logger.log(
      `PC ${pcId} registered with socket ${client.id}` +
        (ipTerlihat ? ` (ip ${ipTerlihat} via ${this.sumberIp(client)})` : ' (ip tidak terbaca)'),
    );

    // Kirim konfigurasi OTP Telegram ke agent yang baru (re)register supaya
    // setting yang disimpan saat agent offline ikut tersimpan di disk PC.
    await this.sendOtpConfigTo(pcId, client.id);
    await this.sendBypassConfigTo(pcId, client.id);
    await this.sendNextcloudConfigTo(pcId, client.id);
    return true;
  }

  /**
   * Ambil hash PIN bypass dari DB lalu kirim ke satu socket agent. Yang dikirim
   * hanya hash-nya supaya client bisa verifikasi lokal, tetap jalan saat server
   * mati. Hash kosong berarti client pakai PIN emergency bawaan.
   */
  private async sendBypassConfigTo(pcId: string, socketId: string): Promise<void> {
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: BYPASS_PIN_HASH_KEY },
      });
      const hash = row?.value ?? '';
      if (!hash) return;
      this.server.to(socketId).emit('agent:bypass_config', { hash });
      this.logger.log(`PIN bypass config dikirim ke agent ${pcId} saat register`);
    } catch (err) {
      this.logger.warn(
        `Gagal mengirim PIN bypass config ke ${pcId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Dorong hash PIN bypass ke SEMUA agent yang tersambung. Dipanggil dari
   * SettingsController setelah admin menyimpan PIN, supaya tidak perlu tunggu
   * agent reconnect.
   */
  async pushBypassConfig(): Promise<number> {
    if (this.pcSocketMap.size === 0) return 0;
    let terkirim = 0;
    let hash = '';
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: BYPASS_PIN_HASH_KEY },
      });
      hash = row?.value ?? '';
    } catch (err) {
      this.logger.warn(
        `Gagal baca hash PIN bypass: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    for (const [pcId, socketId] of this.pcSocketMap.entries()) {
      this.server.to(socketId).emit('agent:bypass_config', { hash });
      terkirim++;
    }
    this.logger.log(
      `PIN bypass config dikirim ke ${terkirim} agent (${hash ? 'hash baru' : 'dikosongkan'})`,
    );
    return terkirim;
  }

  /**
   * Kirim Ulang konfigurasi Nextcloud ke SATU agent karena namanya berubah.
   *
   * ⚠️ Ini wajib dipanggil setelah `namaPc` diubah. Nama PC dipakai sebagai
   * AWALAN nama berkas log yang diunggah ke Nextcloud
   * (`Agent.Core/NextcloudLogUploader.cs`), dan agent menerimanya lewat
   * `agent:nextcloud_config`. Tanpa dorongan ini, agent memakai nama LAMA
   * sampai PC-nya reconnect — dan karenaoperator sering mengganti nama PC
   * tepat saat memperbaiki mesin, log repair-nya bisa tersimpan di folder
   * dengan nama PC yang sudah tidak dipakai.
   */
  async kirimUlangNamaPc(pcId: string): Promise<void> {
    const socketId = this.pcSocketMap.get(pcId);
    if (!socketId) return;
    await this.sendNextcloudConfigTo(pcId, socketId);
  }

  /** Ambil setting OTP dari DB lalu kirim ke satu socket agent. */
  /**
   * Kirim konfigurasi Nextcloud ke satu agent (dipakai saat register).
   *
   * Kosong berarti fitur tidak dipakai; agent lalu berhenti sebelum melakukan
   * apa pun, jadi tidak ada request sia-sia ke server yang memang tidak ada.
   */
  private async sendNextcloudConfigTo(pcId: string, socketId: string): Promise<void> {
    try {
      const rows = await this.prisma.setting.findMany({
        where: { key: { in: NEXTCLOUD_KEYS_DI_GATEWAY } },
      });
      const map = new Map(rows.map((r) => [r.key, r.value ?? '']));
      const url = map.get(NEXTCLOUD_URL_KEY) ?? '';
      const user = map.get(NEXTCLOUD_USER_KEY) ?? '';
      const pass = map.get(NEXTCLOUD_PASSWORD_KEY) ?? '';
      const folder = map.get(NEXTCLOUD_FOLDER_KEY) || NEXTCLOUD_FOLDER_BAVAAN;
        if (!url || !user) return;
        // Nama PC ikut dikirim karena inilah satu-satunya identifier yang bisa
        // dikenali manusia. Tanpa itu nama berkasnya jadi UUID, dan kasir tidak
        // bisa memetakan berkas mana milik PC yang sedang dia perbaiki.
        const pc = await this.prisma.pc.findUnique({
          where: { id: pcId },
          select: { namaPc: true },
        });
        this.server
          .to(socketId)
          .emit('agent:nextcloud_config', { url, user, pass, folder, nama: pc?.namaPc ?? '' });
        this.logger.log(`Nextcloud config dikirim ke agent ${pcId} saat register`);
    } catch (err) {
      this.logger.warn(
        `Gagal mengirim Nextcloud config ke ${pcId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Broadcast konfigurasi Nextcloud ke semua agent aktif. */
  async pushNextcloudConfig(url: string, user: string, pass: string, folder: string): Promise<number> {
    let terkirim = 0;
    for (const [pcId, socketId] of this.pcSocketMap.entries()) {
      // Nama PC berbeda-beda, jadi tidak bisa diambil sekali untuk semua.
      const pc = await this.prisma.pc.findUnique({
        where: { id: pcId },
        select: { namaPc: true },
      });
      this.server
        .to(socketId)
        .emit('agent:nextcloud_config', { url, user, pass, folder, nama: pc?.namaPc ?? '' });
      terkirim++;
      this.logger.log(`Nextcloud config dikirim ke agent ${pcId} (${socketId})`);
    }
    return terkirim;
  }

  private async sendOtpConfigTo(pcId: string, socketId: string): Promise<void> {
    try {
      const rows = await this.prisma.setting.findMany({
        where: { key: { in: [OTP_BOT_TOKEN_KEY, OTP_CHAT_ID_KEY] } },
      });
      const map = new Map(rows.map((r) => [r.key, r.value ?? '']));
      const botToken = map.get(OTP_BOT_TOKEN_KEY) ?? '';
      const chatId = map.get(OTP_CHAT_ID_KEY) ?? '';
      if (!botToken && !chatId) return;
      this.server.to(socketId).emit('agent:otp_config', { botToken, chatId });
      this.logger.log(`OTP config dikirim ke agent ${pcId} saat register`);
    } catch (err) {
      this.logger.warn(
        `Gagal mengirim OTP config ke ${pcId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Nama header yang dipakai untuk memperoleh IP — aids diagnosis topologi. */
  private sumberIp(client: Socket): string {
    const header = client.handshake.headers as Record<string, string | string[] | undefined>;
    const ada = (kunci: string): boolean => {
      const v = header[kunci.toLowerCase()];
      return Array.isArray(v) ? !!v[0] : !!v;
    };
    if (ada('cf-connecting-ip')) return 'cf-connecting-ip';
    if (ada('x-real-ip')) return 'x-real-ip';
    if (ada('x-forwarded-for')) return 'x-forwarded-for';
    return 'socket';
  }

  private async registerAgentFromHandshake(client: Socket, pcId: string): Promise<boolean> {
    const q = client.handshake?.query;
    const qPcId = q?.pcId;
    const qAgentToken = q?.agentToken;
    if (typeof qPcId !== 'string' || typeof qAgentToken !== 'string' || qPcId !== pcId) {
      this.logger.warn(
        `Re-registrasi dari handshake gagal untuk PC ${pcId} (socket ${client.id}): ` +
          `pcId handshake=${typeof qPcId === 'string' ? qPcId : '<kosong>'} agentToken=${typeof qAgentToken === 'string' ? '<ada>' : '<kosong>'}`,
      );
      return false;
    }
    return this.registerAgent(client, qPcId, qAgentToken);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`Client disconnected: ${client.id}`);

    const pcId = this.socketPcMap.get(client.id);
    if (pcId) {
      this.logger.warn(`PC ${pcId} terputus dari server (socket ${client.id})`);
      this.socketPcMap.delete(client.id);
      this.pcSocketMap.delete(pcId);
      await this.sessionService.handleDisconnect(pcId);
    }

    this.dashboardSockets.delete(client.id);
  }

  @SubscribeMessage('agent:register')
  async handleAgentRegister(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string; agentToken: string },
  ): Promise<{ success: boolean; message?: string }> {
    const { pcId, agentToken } = data;

    const ok = await this.registerAgent(client, pcId, agentToken);
    if (!ok) {
      return { success: false, message: 'Invalid agentToken' };
    }
    return { success: true };
  }

  @SubscribeMessage('agent:heartbeat')
  async handleAgentHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string },
  ): Promise<{ success: boolean }> {
    const { pcId } = data;

    const registeredPcId = this.socketPcMap.get(client.id);
    if (registeredPcId !== pcId) {
      const ok = await this.registerAgentFromHandshake(client, pcId);
      if (!ok) {
        this.logger.warn(`Heartbeat PC ${pcId} ditolak: socket ${client.id} belum terdaftar valid`);
        return { success: false };
      }
    }

    await this.sessionService.heartbeat(pcId);
    return { success: true };
  }

  @SubscribeMessage('client:login_request')
  async handleLoginRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string; kredensial: { kode?: string; kodeUnik?: string; nama?: string; password: string } },
  ): Promise<void> {
    const { pcId, kredensial } = data;

    const registeredPcId = this.socketPcMap.get(client.id);
    if (registeredPcId !== pcId) {
      const ok = await this.registerAgentFromHandshake(client, pcId);
      if (!ok) {
        client.emit('client:login_result', { success: false, message: 'PC not registered' });
        return;
      }
    }

    // ⚠️ TEKNISI dicoba PERTAHAMA, sebelum pencarian `Account`.
    //
    // Urutannya penting: kalau technisi dicek setelah `loginRequest()`, kode
    // `teknisi` akan lebih dulu dicocokkan ke `Account.nama`. Dan `Account.nama`
    // adalah kredensial login pelanggan — jadi nama yang sama untuk teknisi dan
    // pelanggan membuat keduanya bisa saling membuka. `simpanAkun()` menolak
    // nama yang bentrok, dan urutannya di sini adalah lapis kedua.
    //
    // Sesi teknisi TIDAK membuat baris `Session` dan TIDAK membuat
    // `Transaction`, jadi tidak masuk `totalLogin` maupun pendapatan laporan.
    const loginTeknisi = await this.cobaLoginTeknisi(pcId, kredensial);
    if (loginTeknisi) {
      return;
    }

    const result = await this.sessionService.loginRequest(pcId, kredensial);

    const kodeInput = kredensial.kode ?? kredensial.kodeUnik ?? kredensial.nama ?? '?';
    this.logger.log(`login_request ${pcId} kode=${kodeInput} → ${result.success ? 'SUKSES' : result.message}`);

    if (result.success) {
      client.emit('client:login_result', { success: true, sessionId: result.sessionId });
      this.emitSessionStart(
        pcId,
        result.sessionId!,
        result.durasiDetikTersedia!,
        result.account!,
      );
      await this.broadcastPcUpdate();
      await this.kabarPemakaiNotifikasi(pcId, result.account!, 'PC');
    } else {
      client.emit('client:login_result', { success: false, message: result.message });
    }
  }

  /**
   * Kabari perangkat admin lewat FCM bahwa ada pelanggan yang mulai sesi.
   *
   * Dibungkus try/catch sendiri dan TIDAK menggagalkan login. Jalur ini sedang
   * dipakai pelanggan yang sedang mengetik kode di komputer, jadi satu masalah
   * notifikasi tidak boleh pernah membuat sesinya gagal start.
   *
   * Nama PC diambil dari database, bukan `pcId`, karena yang tampil di
   * notifikasi adalah "PC-01", bukan UUID.
   */
  private async kabarPemakaiNotifikasi(
    pcId: string,
    akun: { kodeUnik: string | null; nama: string | null; tipe: AccountType },
    sumber: 'PC' | 'Dashboard' | 'HP',
  ): Promise<void> {
    try {
      const pc = await this.prisma.pc.findUnique({
        where: { id: pcId },
        select: { namaPc: true },
      });
      await this.notifikasiService.kirimSesiMulai(
        {
          namaPc: pc?.namaPc ?? 'PC',
          tipe: akun.tipe,
          kodeUnik: akun.kodeUnik,
          nama: akun.nama,
        },
        sumber,
      );
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Notifikasi sesi gagal dikirim: ${pesan}`);
    }
  }

  /**
   * Ganti password akun dari layar PC.
   *
   * Dipakai tombol "Buat Password" di agent. Tidak menanyakan password lama
   * karena semua akun baru mulai dari password bawaan yang sama, dan orang
   * yang memakai komputer tidak perlu mengingat apa pun untuk memulai sesi.
   *
   * Otorisasi wajib lewat `pcId` + `agentToken` seperti login, jadi
   * tidak bisa dipanggil tanpa harus jadi agent yang terdaftar.
   */
  @SubscribeMessage('client:create_password')
  async handleClientCreatePassword(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string; kode: string; passwordLama: string; password: string },
  ): Promise<{ success: boolean; message?: string }> {
    const { pcId, kode, passwordLama, password } = data ?? {};

    const registeredPcId = this.socketPcMap.get(client.id);
    if (registeredPcId !== pcId) {
      const ok = await this.registerAgentFromHandshake(client, pcId);
      if (!ok) {
        return { success: false, message: 'PC not registered' };
      }
    }

    if (!kode?.trim() || !password?.trim() || !passwordLama) {
      return { success: false, message: 'Kode, password lama, dan password baru wajib diisi' };
    }

    const result = await this.sessionService.setPasswordByKode(
      kode.trim(),
      passwordLama,
      password,
    );
    this.logger.log(
      `create_password ${pcId} kode=${kode} → ${result.success ? 'SUKSES' : result.message}`,
    );
    return result;
  }

  @SubscribeMessage('client:stop_session')
  async handleStopSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string },
  ): Promise<{ success: boolean; message?: string }> {
    const { pcId } = data;

    const registeredPcId = this.socketPcMap.get(client.id);
    if (registeredPcId !== pcId) {
      const ok = await this.registerAgentFromHandshake(client, pcId);
      if (!ok) {
        return { success: false, message: 'PC not registered' };
      }
    }

    const result = await this.sessionService.unlockPc(pcId);
    if (result.unlocked) {
      // Dicatat supaya jejak "PC dibuka manual" ada di log. Ini yang penting
      // kalau ada yang bertanya kenapa layar PC terbuka.
      this.broadcastActivityLog('pc_unlock', { pcId, by: 'operator' });
    }
    return { success: result.unlocked, message: result.message };
  }

  emitSessionStart(
    pcId: string,
    sessionId: string,
    durasiDetikTersedia: number,
    account: { kodeUnik: string | null; nama: string | null; tipe: string },
  ): void {
    const socketId = this.pcSocketMap.get(pcId);
    if (socketId) {
      this.server.to(socketId).emit('session:start', {
        sessionId,
        durasiDetikTersedia,
        account: {
          kodeUnik: account.kodeUnik,
          nama: account.nama,
          tipe: account.tipe,
        },
      });
    }
  }

  emitSessionTick(pcId: string, sisaDetik: number): void {
    const socketId = this.pcSocketMap.get(pcId);
    if (socketId) {
      this.server.to(socketId).emit('session:tick', { sisaDetik });
    }
  }

  emitSessionStop(pcId: string, alasan: 'manual' | 'habis' | 'disconnect_timeout'): void {
    const socketId = this.pcSocketMap.get(pcId);
    if (socketId) {
      this.server.to(socketId).emit('session:stop', { alasan });
    }
  }

  /**
   * Dorong konfigurasi OTP Telegram ke SEMUA agent yang sedang tersambung.
   * Dipanggil dari SettingsService saat admin menyimpan bot token / chat id,
   * supaya agent menyimpannya di disk PC dan tetap bisa kirim OTP saat server mati.
   */
  pushOtpConfig(botToken: string, chatId: string): number {
    let terkirim = 0;
    for (const [pcId, socketId] of this.pcSocketMap.entries()) {
      this.server.to(socketId).emit('agent:otp_config', { botToken, chatId });
      terkirim++;
      this.logger.log(`OTP config dikirim ke agent ${pcId} (${socketId})`);
    }
    return terkirim;
  }

  broadcastActivityLog(event: string, payload: Record<string, unknown>): void {
    const at = new Date().toISOString();
    const logEntry = {
      event,
      ...payload,
      at,
    };
    this.server.to('dashboard').emit('dashboard:log', logEntry);

    // Log billing BERKAS. Satu titik ini sudah jadi corong untuk hampir
    // semua aktivitas: sesi mulai dan berakhir, seluruh jenis transaksi
    // akun, kunci/mematikan PC, dan akun yang dinonaktifkan. Menambah event
    // baru cukup lewat sini, tidak perlu menyeberang ke modul lain.
    //
    // Berbeda dari yang di bawah, yang ini tidak pernah melempar: penulisan
    // berkas gagal tidak boleh mengganggu operasi yang sedang berjalan.
    this.logBilling.tulis(event, { ...payload, by: (payload['by'] as string) ?? null });

    // Save to database (fire and forget)
    this.activityLogService.create({
      event,
      detail: JSON.stringify(payload),
      pcId: (payload['pcId'] as string) ?? null,
      accountId: (payload['accountId'] as string) ?? null,
      kasirId: (payload['kasirId'] as string) ?? null,
    }).catch((err) => {
      this.logger.error(`Failed to save activity log: ${err.message}`);
    });
  }

  async broadcastPcUpdate(): Promise<void> {
    // Aman dari penolakan. Method ini dipanggil TANPA await dari beberapa
    // tempat (termasuk dari tick sesi), jadi penolakan di sini akan jadi
    // unhandled rejection. Itu pernah mematikan seluruh proses Node.
    try {
      const data = await this.sessionService.getDashboardData();
      this.server.to('dashboard').emit('dashboard:pc_update', {
        pcs: data,
        at: new Date().toISOString(),
      });
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.logger.warn(`broadcastPcUpdate gagal: ${pesan}`);
    }
  }

  /** Dipakai tick sesi untuk mencatat masalah tanpa risiko melempar. */
  logTickError(pesan: string): void {
    this.logger.warn(pesan);
  }

  /**
   * Kunci layar PC (event `admin:lock` ke agent).
   *
   * ⚠️ Sengaja terpisah dari `handleDashboardLockPc()`: pemanggil itu sekaligus
   * menjalankan `unlockPc()` (menghentikan sesi), sedangkan kasus "PC ditandai
   * rusak" sesinya sudah dihentikan lebih dulu oleh `PcService`. Yang dibutuhkan
   * di sana hanya mengunci layarnya.
   */
  async kunciLayarPc(pcId: string): Promise<void> {
    const socketId = this.pcSocketMap.get(pcId);
    if (!socketId) {
      // PC offline = normal, bukan error. Tidak ada layar yang perlu dikunci.
      return;
    }
    this.server.to(socketId).emit('admin:lock', { pcId });
  }

  /**
   * Kirim `admin:shutdown` ke agent — perintah matikan mesin setelah PC idle.
   *
   * ⚠️ Mengembalikan boolean, bukan `void`. `SessionService.checkAutoShutdown()`
   * memakai nilai balik itu untuk membedakan "terkirim" dari "agent offline".
   * Kalau agent offline, timer harus dibiarkan menyala supaya perintahnya
   * masih bisa dikirim begitu PC konek lagi — kalau tidak, PC itu menggantung
   * menyala tanpa pernah dimatikan.
   */
  async matikanPcOtomatis(pcId: string): Promise<boolean> {
    const socketId = this.pcSocketMap.get(pcId);
    if (!socketId) {
      return false;
    }
    this.server.to(socketId).emit('admin:shutdown', { pcId });
    this.logger.log(`Perintah auto-matikan dikirim ke agent ${pcId}`);
    return true;
  }

  @SubscribeMessage('dashboard:subscribe')
  async handleDashboardSubscribe(@ConnectedSocket() client: Socket): Promise<{ success: boolean }> {
    client.join('dashboard');
    this.dashboardSockets.add(client.id);
    const data = await this.sessionService.getDashboardData();
    client.emit('dashboard:pc_update', { pcs: data, at: new Date().toISOString() });
    this.logger.log(`Dashboard subscribed: ${client.id}`);
    return { success: true };
  }

  @SubscribeMessage('dashboard:start_pc')
  async handleDashboardStartPc(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string; kode: string },
  ): Promise<{ success: boolean; message?: string; sessionId?: string }> {
    if (!this.requireDashboardRole(client)) {
      return { success: false, message: 'Hanya Admin/Kasir yang boleh start sesi' };
    }
    const { pcId, kode } = data ?? {};
    if (!pcId || !kode?.trim()) {
      return { success: false, message: 'pcId dan kode wajib diisi' };
    }
    const socketId = this.pcSocketMap.get(pcId);
    if (!socketId) {
      return { success: false, message: 'PC tidak terhubung' };
    }
    const result = await this.sessionService.startFromDashboard(pcId, kode.trim());
    if (!result.success) {
      return { success: false, message: result.message };
    }
    // Minggati WaitingForLogin di overlay: kirim session:start agar PC unlock + mini window muncul.
    this.emitSessionStart(pcId, result.sessionId!, result.durasiDetikTersedia!, result.account!);
    this.broadcastActivityLog('session:started_dashboard', {
      pcId,
      akun: result.account?.kodeUnik ?? result.account?.nama,
      by: this.actorName(client),
      kasirId: client.data.userId,
    });
    await this.kabarPemakaiNotifikasi(pcId, result.account!, 'Dashboard');
    return { success: true, sessionId: result.sessionId };
  }

  @SubscribeMessage('dashboard:start_voucher')
  async handleDashboardStartVoucher(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string; nominal: number },
  ): Promise<{ success: boolean; message?: string; sessionId?: string; voucher?: { kodeUnik: string; password: string; nominal: number } }> {
    if (!this.requireDashboardRole(client)) {
      return { success: false, message: 'Hanya Admin/Kasir yang boleh buat voucher & start' };
    }
    const { pcId, nominal } = data ?? {};
    if (!pcId || !nominal) {
      return { success: false, message: 'pcId dan nominal wajib diisi' };
    }
    const socketId = this.pcSocketMap.get(pcId);
    if (!socketId) {
      return { success: false, message: 'PC tidak terhubung' };
    }
    const kasirId = client.data.userId ?? '';
    const result = await this.sessionService.createVoucherAndStart(pcId, nominal, kasirId);
    if (!result.success) {
      return { success: false, message: result.message };
    }
    this.emitSessionStart(pcId, result.sessionId!, result.durasiDetikTersedia!, {
      kodeUnik: result.voucher?.kodeUnik ?? null,
      nama: null,
      tipe: AccountType.VOUCHER,
    });
    await this.kabarPemakaiNotifikasi(
      pcId,
      {
        kodeUnik: result.voucher?.kodeUnik ?? null,
        nama: null,
        tipe: AccountType.VOUCHER,
      },
      'Dashboard',
    );
    return {
      success: true,
      sessionId: result.sessionId,
      voucher: result.voucher,
    };
  }

  @SubscribeMessage('dashboard:lock_pc')
  async handleDashboardLockPc(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.requireDashboardRole(client)) {
      return { success: false, message: 'Hanya Admin/Kasir yang boleh mengunci PC' };
    }
    const { pcId } = data ?? {};
    const socketId = this.pcSocketMap.get(pcId);
    if (!socketId) {
      return { success: false, message: 'PC tidak terhubung' };
    }
    await this.sessionService.unlockPc(pcId);
    this.server.to(socketId).emit('admin:lock', { pcId });
    this.broadcastActivityLog('pc_lock', {
      pcId,
      by: this.actorName(client),
      kasirId: client.data.userId,
    });
    await this.broadcastPcUpdate();
    return { success: true, message: 'Perintah kunci terkirim' };
  }

  @SubscribeMessage('dashboard:shutdown_pc')
  async handleDashboardShutdownPc(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pcId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.requireDashboardRole(client)) {
      return { success: false, message: 'Hanya Admin/Kasir yang boleh mematikan PC' };
    }
    const { pcId } = data ?? {};
    const socketId = this.pcSocketMap.get(pcId);
    if (!socketId) {
      return { success: false, message: 'PC tidak terhubung' };
    }
    await this.sessionService.unlockPc(pcId);
    this.server.to(socketId).emit('admin:shutdown', { pcId });
    this.broadcastActivityLog('pc_shutdown', {
      pcId,
      by: this.actorName(client),
      kasirId: client.data.userId,
    });
    await this.broadcastPcUpdate();
    return { success: true, message: 'Perintah mati terkirim' };
  }

  private requireDashboardRole(client: Socket): boolean {
    const role = client.data.role;
    if (role === Role.ADMIN || role === Role.KASIR) {
      return true;
    }
    this.logger.warn(`Dashboard ${client.id} mencoba kontrol tanpa role yang sah`);
    return false;
  }

  /** IP asli PC klien.
   *
   *  Bila agent konek lewat Cloudflare Tunnel, `handshake.address` hanya berisi IP
   *  tunnel connector di host kita — bukan IP PC. Cloudflare menaruh IP asli di header
   *  `CF-Connecting-IP` (fallback umum: `X-Real-IP`, lalu entri pertama
   *  `X-Forwarded-For`). Koneksi langsung dari LAN tidak mengirim header itu, jadi
   *  `handshake.address` tetap dipakai sebagai fallback terakhir.
   *
   *  Semua nilai dibersihkan dari bentuk IPv6-mapped IPv4 (`::ffff:192.168.1.5`).
   *  Null bila tidak ada kandidat yang berupa IP valid. */
  private alamatIp(client: Socket): string | null {
    const header = client.handshake.headers as Record<string, string | string[] | undefined>;
    const ambil = (kunci: string): string | undefined => {
      const v = header[kunci.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    const kandidat = [
      ambil('cf-connecting-ip'),
      ambil('x-real-ip'),
      ambil('x-forwarded-for')?.split(',')[0],
      client.handshake.address,
    ];

    for (const mentah of kandidat) {
      if (!mentah) continue;
      const ip = mentah.trim().replace(/^::ffff:/i, '');
      if (isIP(ip)) return ip;
    }
    return null;
  }

  /** Nama orang yang koneksi ke dashboard, untuk jejak aktivitas.
   *  Fallback ke role bila username tidak ada (mis. token lama). */
  private actorName(client: Socket): string {
    return client.data.username ?? client.data.role ?? 'unknown';
  }
}