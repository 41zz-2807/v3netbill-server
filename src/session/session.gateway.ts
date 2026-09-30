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
import { PrismaService } from '../prisma/prisma.service.js';
import { OTP_BOT_TOKEN_KEY, OTP_CHAT_ID_KEY } from '../settings/otp-keys.js';
import { BYPASS_PIN_HASH_KEY } from '../settings/bypass-keys.js';

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
  ) {}

  afterInit(server: Server): void {
    this.logger.log('SessionGateway initialized');
    this.sessionService.setGatewayEvents(this);
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

  private async registerAgent(client: Socket, pcId: string, agentToken: string): Promise<boolean> {
    const isValid = await this.sessionService.validateAgentToken(pcId, agentToken);
    if (!isValid) {
      this.logger.warn(`Invalid agentToken untuk PC ${pcId} (socket ${client.id})`);
      return false;
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
    await this.broadcastPcUpdate();

    this.logger.log(
      `PC ${pcId} registered with socket ${client.id}` +
        (ipTerlihat ? ` (ip ${ipTerlihat} via ${this.sumberIp(client)})` : ' (ip tidak terbaca)'),
    );

    // Kirim konfigurasi OTP Telegram ke agent yang baru (re)register supaya
    // setting yang disimpan saat agent offline ikut tersimpan di disk PC.
    await this.sendOtpConfigTo(pcId, client.id);
    await this.sendBypassConfigTo(pcId, client.id);
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

  /** Ambil setting OTP dari DB lalu kirim ke satu socket agent. */
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
      await this.kabarPemakaiNotifikasi(pcId, result.account!.tipe);
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
    tipe: AccountType,
  ): Promise<void> {
    try {
      const pc = await this.prisma.pc.findUnique({
        where: { id: pcId },
        select: { namaPc: true },
      });
      await this.notifikasiService.kirimSesiMulai({
        namaPc: pc?.namaPc ?? 'PC',
        tipe,
      });
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
    const logEntry = {
      event,
      ...payload,
      at: new Date().toISOString(),
    };
    this.server.to('dashboard').emit('dashboard:log', logEntry);

    // Save to database (fire and forget)
    this.activityLogService.create({
      event,
      detail: JSON.stringify(payload),
      pcId: (payload.pcId as string) ?? null,
      accountId: (payload.accountId as string) ?? null,
      kasirId: (payload.kasirId as string) ?? null,
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