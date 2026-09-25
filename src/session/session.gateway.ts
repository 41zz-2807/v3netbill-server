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
import { SessionService, SessionGatewayEvents } from './session.service.js';
import { JwtService } from '@nestjs/jwt';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Role, AccountType } from '@prisma/client';

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
  ) {}

  afterInit(server: Server): void {
    this.logger.log('SessionGateway initialized');
    this.sessionService.setGatewayEvents(this);
  }

  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Client connected: ${client.id}`);

    // Dashboard login: verifikasi JWT di handshake auth → simpan role + userId.
    const authToken = (client.handshake.auth as { token?: string } | undefined)?.token;
    if (authToken) {
      try {
        const payload = await this.jwtService.verifyAsync<{ role: Role; sub?: string }>(authToken);
        if (payload.role === Role.ADMIN || payload.role === Role.KASIR) {
          client.data.role = payload.role;
          client.data.userId = payload.sub;
        }
      } catch {
        client.data.role = undefined;
        client.data.userId = undefined;
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

    await this.sessionService.registerPc(pcId);
    await this.broadcastPcUpdate();

    this.logger.log(`PC ${pcId} registered with socket ${client.id}`);
    return true;
  }

  private async registerAgentFromHandshake(client: Socket, pcId: string): Promise<boolean> {
    const q = client.handshake?.query;
    const qPcId = q?.pcId;
    const qAgentToken = q?.agentToken;
    if (typeof qPcId !== 'string' || typeof qAgentToken !== 'string' || qPcId !== pcId) {
      return false;
    }
    return this.registerAgent(client, qPcId, qAgentToken);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`Client disconnected: ${client.id}`);

    const pcId = this.socketPcMap.get(client.id);
    if (pcId) {
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
    } else {
      client.emit('client:login_result', { success: false, message: result.message });
    }
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

  broadcastActivityLog(event: string, payload: Record<string, unknown>): void {
    this.server.to('dashboard').emit('dashboard:log', {
      event,
      ...payload,
      at: new Date().toISOString(),
    });
  }

  async broadcastPcUpdate(): Promise<void> {
    const data = await this.sessionService.getDashboardData();
    this.server.to('dashboard').emit('dashboard:pc_update', {
      pcs: data,
      at: new Date().toISOString(),
    });
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
    this.broadcastActivityLog('pc_lock', { pcId, by: client.data.role });
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
    this.broadcastActivityLog('pc_shutdown', { pcId, by: client.data.role });
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
}