import { Injectable, Logger, OnModuleDestroy, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import * as bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';
import { AccountStatus, SessionStatus, PcStatus, AccountType, TransactionType, Prisma } from '@prisma/client';
import { AMBANG_OFFLINE_MS, statusPcDitampilkan } from '../pc/pc-status.js';
import { PANJANG_PASSWORD_MIN, PASSWORD_DEFAULT } from '../accounts/password.js';

export interface DashboardPcInfo {
  id: string;
  namaPc: string;
  ipClient: string;
  status: PcStatus;
  lastHeartbeatAt: Date | null;
  session: {
    id: string;
    accountId: string;
    kodeUnik: string | null;
    nama: string | null;
    tipe: AccountType;
    sisaDetik: number;
    waktuMulai: Date;
  } | null;
}

/**
 * Alasan sesi dihentikan.
 *
 * `akun_nonaktif` ditambahkan 30 Sep. Alasannya bukan string di database —
 * Session tidak punya kolom alasan, jadi nilainya hanya ikut di payload
 * ActivityLog. Karena itu menambah nilai baru TIDAK butuh migrasi.
 *
 * Nilainya tetap dibatasi 'manual' | 'habis' | 'disconnect_timeout' |
 * 'akun_nonaktif' supaya alasan yang tidak dikenal tidak bisa diam-diam
 * masuk ke log.
 */
export type AlasanStop =
  | 'manual'
  | 'habis'
  | 'disconnect_timeout'
  | 'akun_nonaktif';

export interface SessionGatewayEvents {
  emitSessionStart(
    pcId: string,
    sessionId: string,
    durasiDetikTersedia: number,
    account: { kodeUnik: string | null; nama: string | null; tipe: AccountType },
  ): void;
  emitSessionTick(pcId: string, sisaDetik: number): void;
  emitSessionStop(pcId: string, alasan: AlasanStop): void;
  broadcastPcUpdate(): Promise<void>;
  broadcastActivityLog(event: string, payload: Record<string, unknown>): void;
  /** Catat masalah pada tick sesi tanpa pernah melempar. */
  logTickError(pesan: string): void;
  /**
   * Nama PC berubah, jadi agent perlu diberi tahu karena memakai nama itu
   * sebagai awalan nama berkas log Nextcloud. Async karena gateway melakukan
   * query DB; pemanggilnya WAJIB dibungkus try/catch.
   */
  kirimUlangNamaPc(pcId: string): Promise<void>;
  /**
   * Kunci layar PC secara langsung (event `admin:lock` ke agent).
   *
   * ⚠️ Dipisah dari `dashboard:lock_pc` karena pemanggil itu sekaligus
   * menjalankan `unlockPc()` (menghentikan sesi). Kasus "PC ditandai rusak"
   * sesinya sudah dihentikan lebih dulu oleh `PcService`, jadi yang dibutuhkan
   * hanya mengunci layarnya.
   */
  kunciLayarPc(pcId: string): Promise<void>;
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private sessionIntervals: Map<string, NodeJS.Timeout> = new Map();
  private disconnectCheckInterval: NodeJS.Timeout | null = null;
  private gracePeriodDetik: number = 180;
  private gatewayEvents: SessionGatewayEvents | null = null;

  constructor(private prisma: PrismaService) {
    this.loadGracePeriod();
    this.startDisconnectCheck();
  }

  setGatewayEvents(events: SessionGatewayEvents): Promise<void> {
    this.gatewayEvents = events;
    return this.recoverRunningSessions();
  }

  /**
   * Kabari agent bahwa nama PC-nya berubah.
   *
   * Dipanggil setelah `namaPc` di-update. Jangan pernah melempar: nama PC
   * hanya Cosmetic, dan kegagalan push ke agent tidak boleh membatalkan
   * pengubahan nama yang sudah tersimpan.
   */
  async kirimUlangNamaKeAgent(pcId: string): Promise<void> {
    try {
      await this.gatewayEvents?.kirimUlangNamaPc(pcId);
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.gatewayEvents?.logTickError(`kirim nama PC baru gagal: ${pesan}`);
    }
  }

  /**
   * Kunci layar PC. Aman dipanggil tanpa try/catch di pemanggil — metode ini tidak
   * pernah melempar, karena PC offline adalah kondisi normal (bukan error).
   */
  async kunciLayarPc(pcId: string): Promise<void> {
    try {
      await this.gatewayEvents?.kunciLayarPc(pcId);
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.gatewayEvents?.logTickError(`kunci layar PC gagal: ${pesan}`);
    }
  }

  /**
   * Dorong ulang daftar PC ke dashboard (event `dashboard:pc_update`).
   *
   * ⚠️ Dipakai `PcService` setelah flag "PC rusak" berubah, supaya PC itu
   * hilang dari dashboard seketika tanpa menunggu 10 detik polling.
   * Tidak pernah melempar — pemanggilnya tidak perlu try/catch.
   */
  async broadcastPcUpdate(): Promise<void> {
    try {
      await this.gatewayEvents?.broadcastPcUpdate();
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      this.gatewayEvents?.logTickError(`broadcast daftar PC gagal: ${pesan}`);
    }
  }

  private async recoverRunningSessions(): Promise<void> {
    const sessions = await this.prisma.session.findMany({
      where: { status: SessionStatus.BERJALAN },
    });
    for (const s of sessions) {
      this.startSessionTick(s.id);
    }
    if (sessions.length > 0) {
      this.logger.log(`Recovery: ${sessions.length} sesi berjalan — tick loop di-restart`);
    }
  }

  private async loadGracePeriod(): Promise<void> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: 'grace_period_detik' },
    });
    // Setting bisa kosong atau berisi sampah. parseInt dari nilai itu
    // menghasilkan NaN, dan NaN * 1000 jadi Invalid Date yang ditolak Prisma.
    const parsed = setting ? parseInt(setting.value, 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      this.gracePeriodDetik = parsed;
    } else {
      if (setting) {
        this.logger.warn(
          `grace_period_detik tidak valid ("${setting.value}") — pakai default 180 detik`,
        );
      }
      this.gracePeriodDetik = 180;
    }
  }

  async getGracePeriod(): Promise<number> {
    await this.loadGracePeriod();
    return this.gracePeriodDetik;
  }

  async validateAgentToken(pcId: string, agentToken: string): Promise<boolean> {
    const pc = await this.prisma.pc.findUnique({
      where: { id: pcId },
    });
    return pc?.agentToken === agentToken;
  }

  async registerPc(pcId: string, ipTerlihat?: string | null): Promise<void> {
    const runningSession = await this.prisma.session.findFirst({
      where: { pcId, status: SessionStatus.BERJALAN },
    });
    const data: Prisma.PcUpdateInput = {
      status: runningSession ? PcStatus.ACTIVE : PcStatus.IDLE,
      lastHeartbeatAt: new Date(),
    };
    // Hanya tulis IP kalau berubah, supaya tidak menyentuh baris Pc tiap reconnect.
    if (ipTerlihat) {
      const pc = await this.prisma.pc.findUnique({
        where: { id: pcId },
        select: { ipClient: true },
      });
      if (pc && pc.ipClient !== ipTerlihat) {
        data.ipClient = ipTerlihat;
      }
    }
    await this.prisma.pc.update({ where: { id: pcId }, data });
    this.gatewayEvents?.broadcastPcUpdate();
  }

  async heartbeat(pcId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { pcId, status: SessionStatus.BERJALAN },
    });

    await this.prisma.pc.update({
      where: { id: pcId },
      data: {
        lastHeartbeatAt: new Date(),
        // ⚠️ WAJIB. `checkPcOffline()` menulis OFFLINE ke kolom `status` tiap
        // 10 detik, dan sebelum baris ini satu-satunya yang mengembalikannya
        // adalah `registerPc()` — yaitu hanya saat agent reconnect. Kalau
        // heartbeat tertinggal satu kali (>30 detik) tanpa memutus socket,
        // kolomnya tetap OFFLINE padahal agentnya sehat: dashboard kehilangan
        // hitung mundur, tombol Start muncul di PC yang sedang tersesi, dan
        // Start itu selalu ditolak "PC sudah memiliki sesi berjalan".
        status: session ? PcStatus.ACTIVE : PcStatus.IDLE,
      },
    });

    if (session?.disconnectedAt) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { disconnectedAt: null },
      });
    }
  }

  async getDashboardData(): Promise<DashboardPcInfo[]> {
    const [pcs, sessionsBerjalan] = await Promise.all([
      // PC yang ditandai rusak tidak muncul di dashboard. Daftar ini juga
      // dipakai aplikasi mobile lewat `dashboard:pc_update`, jadi satu filter di
      // sini menutup kedua-duanya.
      //
      // ⚠️ Jangan ikut menyaring laporan. Rekap dihitung dari `Transaction`,
      // jadi PC yang ditandai tetap masuk rekap harian.
      this.prisma.pc.findMany({
        where: { rusak: false },
        orderBy: { namaPc: 'asc' },
      }),
      this.prisma.session.findMany({
        where: { status: SessionStatus.BERJALAN },
      }),
    ]);

    const accountIds = sessionsBerjalan.map((s) => s.accountId);
    const accounts = accountIds.length > 0
      ? await this.prisma.account.findMany({ where: { id: { in: accountIds } } })
      : [];

    const accountMap = new Map(accounts.map((a) => [a.id, a]));
    const sessionByPc = new Map<string, (typeof sessionsBerjalan)[number]>();
    for (const s of sessionsBerjalan) {
      sessionByPc.set(s.pcId, s);
    }

    return pcs.map((pc) => {
      const session = sessionByPc.get(pc.id);
      // Kolom `status` bisa berisi OFFLINE (ditulis `checkPcOffline()`), jadi
      // yang menentukan adalah heartbeat — dan kalau ada sesi berjalan dengan
      // heartbeat segar, statusnya ACTIVE apa pun isi kolom.
      //
      // ⚠️ HARUS `sessionByPc.has(pc.id)`, bukan `session !== null`. `Map.get()`
      // mengembalikan `undefined` kalau kuncinya tidak ada, dan
      // `undefined !== null` itu TRUE — sehingga SEMUA PC tanpa sesi ikut
      // terbaca ACTIVE. Gejalanya persis seperti bug aslinya: PC idle tampil
      // "Aktif" padahal tidak ada sesi sama sekali.
      const status = statusPcDitampilkan(pc.status, pc.lastHeartbeatAt, sessionByPc.has(pc.id));
      if (!session) {
        return {
          id: pc.id,
          namaPc: pc.namaPc,
          ipClient: pc.ipClient,
          status,
          lastHeartbeatAt: pc.lastHeartbeatAt,
          session: null,
        };
      }

      const account = accountMap.get(session.accountId);
      const elapsedDetik = Math.max(0, Math.floor((Date.now() - session.waktuMulai.getTime()) / 1000));
      const sisaDetik = account ? Math.max(0, account.sisaWaktuDetik - elapsedDetik) : 0;

      return {
        id: pc.id,
        namaPc: pc.namaPc,
        ipClient: pc.ipClient,
        status,
        lastHeartbeatAt: pc.lastHeartbeatAt,
        session: {
          id: session.id,
          accountId: session.accountId,
          kodeUnik: account?.kodeUnik ?? null,
          nama: account?.nama ?? null,
          tipe: account?.tipe ?? AccountType.VOUCHER,
          sisaDetik,
          waktuMulai: session.waktuMulai,
        },
      };
    });
  }

  async loginRequest(
    pcId: string,
    credential: { kode?: string; kodeUnik?: string; nama?: string; password: string },
  ): Promise<{
    success: boolean;
    message?: string;
    sessionId?: string;
    durasiDetikTersedia?: number;
    account?: { kodeUnik: string | null; nama: string | null; tipe: AccountType };
  }> {
    let account;
    const kode = credential.kode ?? credential.kodeUnik;

    if (kode) {
      account =
        (await this.prisma.account.findUnique({
          where: { kodeUnik: kode },
        })) ??
        (await this.cariAkunAktif({ nama: kode }));
    } else if (credential.nama) {
      account = await this.cariAkunAktif({ nama: credential.nama });
    }

    if (!account) {
      return { success: false, message: 'Akun tidak ditemukan' };
    }

    const isPasswordValid = await bcrypt.compare(credential.password, account.passwordHash);
    if (!isPasswordValid) {
      return { success: false, message: 'Password salah' };
    }

    if (account.status !== AccountStatus.ACTIVE) {
      return { success: false, message: 'Akun tidak aktif' };
    }

    if (account.tipe === AccountType.VOUCHER) {
      if (account.sisaWaktuDetik <= 0) {
        return { success: false, message: 'Waktu voucher habis' };
      }

      if (account.lastUsedAt) {
        const daysSinceLastUsed = (Date.now() - new Date(account.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastUsed > 30) {
          return { success: false, message: 'Voucher sudah kedaluwarsa (>30 hari tidak digunakan)' };
        }
      }
    } else if (account.tipe === AccountType.MEMBER) {
      if (account.sisaWaktuDetik <= 0) {
        return { success: false, message: 'Saldo waktu member habis' };
      }
    }

    const existingSession = await this.prisma.session.findFirst({
      where: { pcId, status: SessionStatus.BERJALAN },
    });

    if (existingSession) {
      return { success: false, message: 'PC sudah memiliki sesi berjalan' };
    }

    const session = await this.prisma.session.create({
      data: {
        pcId,
        accountId: account.id,
        waktuMulai: new Date(),
        status: SessionStatus.BERJALAN,
        durasiTerpakaiDetik: 0,
      },
    });

    await this.prisma.account.update({
      where: { id: account.id },
      data: { lastUsedAt: new Date() },
    });

    await this.prisma.pc.update({
      where: { id: pcId },
      data: { status: PcStatus.ACTIVE },
    });

    this.gatewayEvents?.broadcastPcUpdate();
    this.gatewayEvents?.broadcastActivityLog('session:started', {
      sessionId: session.id,
      pcId,
      akun: account.kodeUnik ?? account.nama,
      durasiDetik: account.sisaWaktuDetik,
    });
    this.startSessionTick(session.id);

    return {
      success: true,
      sessionId: session.id,
      durasiDetikTersedia: account.sisaWaktuDetik,
      account: { kodeUnik: account.kodeUnik, nama: account.nama, tipe: account.tipe },
    };
  }

  /**
   * Dashboard (Admin/Kasir) start sesi langsung dengan kode member/voucher — tanpa password.
   * Mirip loginRequest tapi otorisasi dilakukan oleh role dashboard (bukan password akun).
   */
  async startFromDashboard(
    pcId: string,
    kode: string,
  ): Promise<{
    success: boolean;
    message?: string;
    sessionId?: string;
    durasiDetikTersedia?: number;
    account?: { kodeUnik: string | null; nama: string | null; tipe: AccountType };
  }> {
    const account = await this.findAccountByKode(kode);
    if (!account) {
      return { success: false, message: 'Akun tidak ditemukan' };
    }

    if (account.status !== AccountStatus.ACTIVE) {
      return { success: false, message: 'Akun tidak aktif' };
    }

    if (account.tipe === AccountType.VOUCHER) {
      if (account.sisaWaktuDetik <= 0) {
        return { success: false, message: 'Waktu voucher habis' };
      }
      if (account.lastUsedAt) {
        const daysSinceLastUsed = (Date.now() - new Date(account.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastUsed > 30) {
          return { success: false, message: 'Voucher sudah kedaluwarsa (>30 hari tidak digunakan)' };
        }
      }
    } else if (account.tipe === AccountType.MEMBER && account.sisaWaktuDetik <= 0) {
      return { success: false, message: 'Saldo waktu member habis' };
    }

    return this.createSessionAndStart(pcId, account);
  }

  /**
   * Dashboard (Admin/Kasir) buat voucher baru (nominal) lalu langsung start sesi di PC tsb.
   * Kembalikan kode + password voucher agar bisa diserahkan ke pelanggan.
   */
  async createVoucherAndStart(
    pcId: string,
    nominal: number,
    kasirId: string,
  ): Promise<{
    success: boolean;
    message?: string;
    sessionId?: string;
    durasiDetikTersedia?: number;
    voucher?: { kodeUnik: string; password: string; nominal: number };
  }> {
    if (nominal % 500 !== 0) {
      return { success: false, message: 'Nominal harus kelipatan 500' };
    }

    const hargaPerMenit = await this.getHargaPerMenit();
    const sisaWaktuDetik = Math.floor((nominal / hargaPerMenit) * 60);
    // Sama seperti pembuatan lewat halaman akun: password bawaan, bukan acak,
    // supaya kasir cukup mencatat kode voucher saja.
    const password = PASSWORD_DEFAULT;
    const passwordHash = await bcrypt.hash(password, 10);

    let kodeUnik = '';
    for (let i = 0; i < 10; i++) {
      const candidate = Math.floor(100000 + Math.random() * 900000).toString();
      const existing = await this.prisma.account.findUnique({ where: { kodeUnik: candidate } });
      if (!existing) {
        kodeUnik = candidate;
        break;
      }
    }
    if (!kodeUnik) {
      return { success: false, message: 'Gagal generate kode unik, coba lagi' };
    }

    const account = await this.prisma.account.create({
      data: {
        tipe: AccountType.VOUCHER,
        kodeUnik,
        passwordHash,
        sisaWaktuDetik,
        status: AccountStatus.ACTIVE,
      },
    });

    await this.prisma.transaction.create({
      data: {
        accountId: account.id,
        nominal,
        durasiMenit: Math.floor(sisaWaktuDetik / 60),
        jenis: TransactionType.BELI_BARU,
        kasirId,
      },
    });

    const started = await this.createSessionAndStart(pcId, account);
    if (!started.success) {
      return { success: false, message: started.message };
    }
    this.gatewayEvents?.broadcastActivityLog('voucher:created_dashboard', {
      pcId,
      kodeUnik,
      nominal,
    });
    return {
      success: true,
      sessionId: started.sessionId,
      durasiDetikTersedia: started.durasiDetikTersedia,
      voucher: { kodeUnik, password, nominal },
    };
  }

  /**
   * Cari akun yang masih aktif, dan HANYA setelah itu fallback ke akun nonaktif.
   *
   * Prioritaskan yang ACTIVE karena `createMember` SENGAJA mengizinkan nama
   * yang sama kalau yang lama sudah dinonaktifkan (lihat accounts.service.ts).
   * Tanpa filter status di sini, akun lama yang sudah REVOKED bisa menutupi
   * yang baru, dan member yang barusan dibuat akan SELALU ditolak dengan
   * "Akun tidak aktif" — padahal dia tidak mungkin sekali pun bisa login.
   *
   * Fallback ke akun nonaktif tetap dijaga supaya pesannya informatif:
   * "Akun tidak aktif" jauh lebih berguna daripada "Akun tidak ditemukan",
   * karena operator bisa langsung tahu itu akun yang dinonaktifkan, bukan
   * salah ketik.
   */
  private async cariAkunAktif(where: { nama: string }) {
    return (
      (await this.prisma.account.findFirst({
        where: { ...where, status: AccountStatus.ACTIVE },
      })) ?? (await this.prisma.account.findFirst({ where }))
    );
  }

  private async findAccountByKode(kode: string) {
    return (
      (await this.prisma.account.findUnique({ where: { kodeUnik: kode } })) ??
      (await this.cariAkunAktif({ nama: kode }))
    );
  }

  private async getHargaPerMenit(): Promise<number> {
    const setting = await this.prisma.setting.findUnique({ where: { key: 'harga_per_menit' } });
    return setting ? parseInt(setting.value, 10) : 150;
  }

  private async createSessionAndStart(
    pcId: string,
    account: { id: string; kodeUnik: string | null; nama: string | null; tipe: AccountType; sisaWaktuDetik: number },
  ): Promise<{
    success: boolean;
    message?: string;
    sessionId?: string;
    durasiDetikTersedia?: number;
    account?: { kodeUnik: string | null; nama: string | null; tipe: AccountType };
  }> {
    // ⚠️ PC yang ditandai rusak tidak boleh dipakai — dicek di sini, BUKAN di
    // masing-masing pemanggil. Tiga cara mulai sesi (`loginRequest`,
    // `startFromDashboard`, `createVoucherAndStart`) semuanya lewat fungsi ini,
    // jadi satu titik ini menutup semuanya — termasuk percobaan login langsung
    // dari layar PC, yang tidak bisa dicegah dari frontend.
    //
    // ⚠️ Pengecekan ini WAJIB di atas penulisan `lastUsedAt` dan pembuatan
    // `Session`. Kalau ditelepurkan, voucher pelanggan ikut terpakai.
    const pc = await this.prisma.pc.findUnique({
      where: { id: pcId },
      select: { rusak: true },
    });
    if (!pc) {
      return { success: false, message: 'PC tidak ditemukan' };
    }
    if (pc.rusak) {
      return { success: false, message: 'PC sedang tidak dipakai (ditandai rusak)' };
    }

    const existingSession = await this.prisma.session.findFirst({
      where: { pcId, status: SessionStatus.BERJALAN },
    });

    if (existingSession) {
      return { success: false, message: 'PC sudah memiliki sesi berjalan' };
    }

    const session = await this.prisma.session.create({
      data: {
        pcId,
        accountId: account.id,
        waktuMulai: new Date(),
        status: SessionStatus.BERJALAN,
        durasiTerpakaiDetik: 0,
      },
    });

    await this.prisma.account.update({
      where: { id: account.id },
      data: { lastUsedAt: new Date() },
    });

    await this.prisma.pc.update({
      where: { id: pcId },
      data: { status: PcStatus.ACTIVE },
    });

    this.gatewayEvents?.broadcastPcUpdate();
    this.gatewayEvents?.broadcastActivityLog('session:started', {
      sessionId: session.id,
      pcId,
      akun: account.kodeUnik ?? account.nama,
      durasiDetik: account.sisaWaktuDetik,
    });
    this.startSessionTick(session.id);

    return {
      success: true,
      sessionId: session.id,
      durasiDetikTersedia: account.sisaWaktuDetik,
      account: { kodeUnik: account.kodeUnik, nama: account.nama, tipe: account.tipe },
    };
  }

  private startSessionTick(sessionId: string): void {
    if (this.sessionIntervals.has(sessionId)) {
      return;
    }

    const berhenti = () => {
      clearInterval(interval);
      this.sessionIntervals.delete(sessionId);
    };

    const interval = setInterval(async () => {
      // ⚠️ WAJIB. Callback ini async dan dipanggil dari setInterval, jadi
      // penolakan apa pun yang lolos dari sini menjadi unhandled rejection dan
      // MEMATIKAN seluruh proses Node — bukan hanya satu sesi. Semua PC
      // kehilangan billing seketika.
      //
      // Ini bukan teori. Terjadi 30 Sep: `bersihkan-data` (dan skrip uji)
      // menghapus baris `Session` sementara tick-nya masih berjalan. Tick
      // berikutnya memanggil `session.update()` untuk baris yang sudah tidak
      // ada, Prisma melempar P2025, dan proses mati. Ekor lognya panjang sekali
      // karena minified Prisma ikut tercetak.
      try {
        const session = await this.prisma.session.findUnique({
          where: { id: sessionId },
          include: { account: true, pc: true },
        });

        if (!session || session.status !== SessionStatus.BERJALAN) {
          berhenti();
          return;
        }

        // Akun yang dinonaktifkan (revoke) TIDAK BOLEH lanjut berjalan.
        //
        // `loginRequest` menolak akun yang bukan ACTIVE, jadi sesi baru sudah
        // aman. Tapi sesi yang SEDANG berjalan tidak pernah dicek ulang status
        // akunnya: operator menonaktifkan member, dan member itu tetap jalan
        // sampai waktunya habis. Itu celah logika bisnis, bukan sekadar
        // tampilan.
        //
        // Dicek di sini sebagai pengaman. Jalur normally udahan revoke()
        // yang menghentikan sesi seketika, jadi kasus ini hanya terjadi kalau
        // status berubah lewat jalur lain (mis. ubahan langsung di database).
        if (session.account.status !== AccountStatus.ACTIVE) {
          await this.stopSession(sessionId, 'akun_nonaktif');
          berhenti();
          return;
        }

        const elapsedDetik = Math.max(0, Math.floor((Date.now() - session.waktuMulai.getTime()) / 1000));
        const sisaDetik = Math.max(0, session.account.sisaWaktuDetik - elapsedDetik);

        try {
          await this.prisma.session.update({
            where: { id: sessionId },
            data: { durasiTerpakaiDetik: elapsedDetik },
          });
        } catch (e) {
          // P2025 = sesinya dihapus di antara findUnique dan update. Itu hal
          // yang wajar (mis. skrip pembersihan), bukan kondisi error, jadi tick
          // ini harus berhenti dan tidak boleh diulang-ulang mencoba.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
            berhenti();
            return;
          }
          throw e;
        }

        this.gatewayEvents?.emitSessionTick(session.pcId, sisaDetik);
        // Sengaja tidak di-await, jadi pemanggilnya harus aman dari penolakan.
        this.gatewayEvents?.broadcastPcUpdate();

        if (sisaDetik <= 0) {
          await this.stopSession(sessionId, 'habis');
          berhenti();
        }
      } catch (e) {
        // Apa pun yang terjadi, jangan jatuhkan proses. Yang dicatat apa pun,
        // tick berikutnya akan mencoba lagi.
        const pesan = e instanceof Error ? e.message : String(e);
        this.gatewayEvents?.logTickError(`tick sesi ${sessionId}: ${pesan}`);
      }
    }, 1000);

    this.sessionIntervals.set(sessionId, interval);
  }

  async stopSession(sessionId: string, alasan: AlasanStop): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { account: true, pc: true },
    });

    if (!session) {
      return;
    }

    if (this.sessionIntervals.has(sessionId)) {
      clearInterval(this.sessionIntervals.get(sessionId)!);
      this.sessionIntervals.delete(sessionId);
    }

    const waktuSelesai = new Date();
    const durasiTerpakaiDetik = Math.floor((waktuSelesai.getTime() - session.waktuMulai.getTime()) / 1000);

    let sisaWaktuKembali = 0;
    if (alasan !== 'habis') {
      sisaWaktuKembali = Math.max(0, session.account.sisaWaktuDetik - durasiTerpakaiDetik);
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.SELESAI,
        waktuSelesai,
        durasiTerpakaiDetik,
        disconnectedAt: alasan === 'disconnect_timeout' ? session.disconnectedAt : null,
      },
    });

    if (alasan === 'habis') {
      await this.prisma.account.update({
        where: { id: session.accountId },
        data: { sisaWaktuDetik: 0 },
      });
    } else if (sisaWaktuKembali > 0) {
      await this.prisma.account.update({
        where: { id: session.accountId },
        data: { sisaWaktuDetik: sisaWaktuKembali },
      });
    }

    await this.prisma.pc.update({
      where: { id: session.pcId },
      data: { status: PcStatus.IDLE },
    });

    this.gatewayEvents?.emitSessionStop(session.pcId, alasan);
    this.gatewayEvents?.broadcastActivityLog('session:stopped', {
      sessionId,
      pcId: session.pcId,
      alasan,
      durasiTerpakaiDetik,
      sisaWaktuKembali,
    });
    this.gatewayEvents?.broadcastPcUpdate();

    this.logger.log(`Session ${sessionId} stopped: ${alasan}, durasi=${durasiTerpakaiDetik}detik, sisaKembali=${sisaWaktuKembali}detik`);
  }

  /**
   * Hentikan semua sesi yang sedang berjalan milik sebuah akun.
   *
   * Dipakai saat akun dinonaktifkan, supaya PC-nya terkunci SEKETIKA dan bukan
   * menunggu giliran tick. Tick punya pemeriksaan status sebagai pengaman,
   * tapi menunggu satu detik terasa lama kalau operator sedang memperhatikan
   * layarnya.
   *
   * Sisa waktu dikembalikan seperti pada penghentian manual: akunnya
   * dinonaktifkan, bukan dibuang, jadi sisa yang sudah dibayar tidak boleh
   * hilang. Kalau ternyata tidak ada sesi berjalan, hasilnya nol dan tidak ada
   * efek samping.
   */
  async stopSessionsOfAccount(accountId: string): Promise<number> {
    const sessions = await this.prisma.session.findMany({
      where: { accountId, status: SessionStatus.BERJALAN },
      select: { id: true },
    });

    for (const s of sessions) {
      try {
        await this.stopSession(s.id, 'akun_nonaktif');
      } catch (e) {
        // Satu sesi gagal tidak boleh membuat sisa sesi lain terus berjalan.
        // Sengaja ditelan: `stopSession` sudah mengembalikan void dan kegagalannya
        // tercatat di log internalnya.
        const pesan = e instanceof Error ? e.message : String(e);
        this.gatewayEvents?.logTickError(`henti sesi ${s.id}: ${pesan}`);
      }
    }

    if (sessions.length > 0) {
      this.logger.log(
        `${sessions.length} sesi dihentikan karena akun dinonaktifkan`,
      );
    }
    return sessions.length;
  }

  /**
   * Ganti password sebuah akun dari sisi PC.
   *
   * Dipakai tombol "Ganti Password" di mini window agent. Password lama WAJIB
   * dicocokkan dulu: tombol ini baru muncul setelah sesi berjalan, jadi orang
   * yang sedang memakai komputer itu memang pemilik akunnya.
   *
   * Password bawaan semua akun adalah `0000`, dan field password lama di
   * dialog diberi petunjuk nilai itu selama belum pernah diganti.
   */
  async setPasswordByKode(
    kode: string,
    passwordLama: string,
    passwordBaru: string,
  ): Promise<{ success: boolean; message?: string }> {
    const lama = passwordLama ?? '';
    const baru = passwordBaru?.trim() ?? '';

    if (baru.length < PANJANG_PASSWORD_MIN) {
      return {
        success: false,
        message: `Password baru minimal ${PANJANG_PASSWORD_MIN} karakter`,
      };
    }
    if (baru === lama) {
      return { success: false, message: 'Password baru harus berbeda dari yang lama' };
    }

    const account = await this.findAccountByKode(kode);
    if (!account) {
      return { success: false, message: 'Akun tidak ditemukan' };
    }
    if (account.status !== AccountStatus.ACTIVE) {
      return { success: false, message: 'Akun tidak aktif' };
    }

    // findAccountByKode hanya mengembalikan kolom ringkas, jadi hash diambil
    // ulang di sini untuk dicocokkan.
    const lengkap = await this.prisma.account.findUnique({
      where: { id: account.id },
    });
    if (!lengkap || !(await bcrypt.compare(lama, lengkap.passwordHash))) {
      return { success: false, message: 'Password lama salah' };
    }

    await this.prisma.account.update({
      where: { id: account.id },
      data: { passwordHash: await bcrypt.hash(baru, 10) },
    });

    this.logger.log(
      `Password diubah untuk akun ${account.kodeUnik ?? account.nama} (${account.tipe})`,
    );
    return { success: true };
  }

  async handleDisconnect(pcId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: {
        pcId,
        status: SessionStatus.BERJALAN,
      },
    });

    if (session) {
      await this.stopSession(session.id, 'disconnect_timeout');
    }

    this.gatewayEvents?.broadcastPcUpdate();
  }

  /** Owner/admin menghentikan sesi aktif di sebuah PC agar layar terbuka (manual). */
  async unlockPc(pcId: string): Promise<{ unlocked: boolean; message?: string }> {
    const session = await this.prisma.session.findFirst({
      where: { pcId, status: SessionStatus.BERJALAN },
    });

    if (!session) {
      return { unlocked: false, message: 'Tidak ada sesi aktif di PC ini' };
    }

    await this.stopSession(session.id, 'manual');
    return { unlocked: true, message: 'PC dibuka kuncinya' };
  }

  private startDisconnectCheck(): void {
    this.disconnectCheckInterval = setInterval(async () => {
      // Pengaman lapis kedua. Dua checker di bawah sudah punya try/catch
      // sendiri, tapi kalau ada ubahan nanti yang salah satu lupa, callback ini
      // yang harus menjadi penjaga terakhir sebelum proses ikut mati.
      try {
        await this.checkGracePeriodExpired();
        await this.checkPcOffline();
      } catch (e) {
        const pesan = e instanceof Error ? e.message : String(e);
        this.gatewayEvents?.logTickError(`pemeriksaan berkala: ${pesan}`);
      }
    }, 10000);
  }

  /**
   * Tandai PC yang heartbeat-nya sudah basi sebagai OFFLINE lalu siarkan.
   *
   * Ini supaya database tidak menyimpan status yang salah, dan supaya
   * dashboard berubah tanpa harus menunggu ada sesi yang baru dimulai.
   * `broadcastPcUpdate` sebelumnya hanya terkirim saat agent register, sesi
   * mulai, atau sesi berhenti, jadi PC idle yang mati tidak pernah memberi
   * kabar apa pun sama sekali.
   */
  private async checkPcOffline(): Promise<void> {
    try {
      const batas = new Date(Date.now() - AMBANG_OFFLINE_MS);
      const hasil = await this.prisma.pc.updateMany({
        where: {
          status: { not: PcStatus.OFFLINE },
          OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: batas } }],
        },
        data: { status: PcStatus.OFFLINE },
      });
      if (hasil.count > 0) {
        this.logger.log(`${hasil.count} PC ditandai OFFLINE karena heartbeat tidak diterima`);
        this.gatewayEvents?.broadcastPcUpdate();
      }
    } catch (e) {
      this.logger.warn(`Gagal menandai PC offline: ${(e as Error).message}`);
    }
  }

  private async checkGracePeriodExpired(): Promise<void> {
    // Function ini dipanggil dari setInterval. Tanpa try/catch, satu error
    // apa pun di dalamnya jadi unhandled rejection yang menjatuhkan SELURUH
    // proses server, bukan cuma pengiriman جزء dari sesi ini.
    try {
      const gracePeriod = await this.getGracePeriod();
      if (!Number.isFinite(gracePeriod)) {
        return;
      }
      const threshold = new Date(Date.now() - gracePeriod * 1000);

      const sessions = await this.prisma.session.findMany({
        where: {
          status: SessionStatus.BERJALAN,
          disconnectedAt: { not: null, lt: threshold },
        },
        include: { account: true, pc: true },
      });

      for (const session of sessions) {
        this.logger.log(`Grace period expired for session ${session.id}, stopping...`);
        await this.stopSession(session.id, 'disconnect_timeout');
      }
    } catch (e) {
      this.logger.warn(`Gagal mengecek grace period: ${(e as Error).message}`);
    }
  }

  async getSessionStatus(sessionId: string): Promise<{ sisaDetik: number } | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { account: true },
    });

    if (!session || session.status !== SessionStatus.BERJALAN) {
      return null;
    }

    const elapsedMs = Date.now() - session.waktuMulai.getTime();
    const elapsedDetik = Math.floor(elapsedMs / 1000);
    const sisaDetik = Math.max(0, session.account.sisaWaktuDetik - elapsedDetik);

    return { sisaDetik };
  }

  onModuleDestroy(): void {
    for (const interval of this.sessionIntervals.values()) {
      clearInterval(interval);
    }
    this.sessionIntervals.clear();
    if (this.disconnectCheckInterval) {
      clearInterval(this.disconnectCheckInterval);
    }
  }
}