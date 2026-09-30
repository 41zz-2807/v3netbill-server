import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';

/** Audience tetap untuk access token FCM v1. */
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Dipakai ulang kalau access token tinggal < 60 detik. */
const AMAN_SISA_MS = 60_000;

export interface HasilKirim {
  ok: boolean;
  /** Status HTTP dari FCM, atau null kalau tidak pernah terkirim. */
  status: number | null;
  /** Kode error FCM, mis. 'UNREGISTERED'. */
  kode: string | null;
  pesan: string;
  /**
   * True kalau token-nya sudah tidak valid dan TIDAK PERNAH akan dipakai lagi.
   *
   * Ini yang membuat baris token lama dibersihkan sendiri: HP yang di-uninstall
   * atau token yang sudah kedaluwarsa akan ditolak FCM, dan dari situ kita tahu
   * token itu harus dihapus. Tanpa ini tabel token akan menumpuk begitu saja.
   */
  tokenMati: boolean;
}

export interface PesanNotifikasi {
  judul: string;
  isi: string;
  /**
   * Data untuk aplikasi. Ini yang dibaca saat notifikasi ditekan, jadi jangan
   * pernah menaruh kode voucher atau nama member di sini: notifikasi terlihat
   * di layar kunci HP dan nama member adalah kredensial login-nya.
   */
  data?: Record<string, string>;
  /**
   * Channel Android. Wajib diisi. Kalau dikosongkan, FCM memakai channel
   * bawaannya yang importance-nya rendah: notifikasi tetap muncul tapi tanpa
   * suara dan tanpa getaran, dan di Android 8+ praktis tidak terlihat kalau
   * channel itu pernah diblokir.
   *
   * ⚠️ Yang dikirim HANYA `channel_id`. `message.android.notification` TIDAK
   * punya field `channel_name` — nama channel hanya dipakai saat channel itu
   * dibuat di perangkat, dan mengirim field tak dikenal membuat FCM membalas
   * 400 untuk SETIAP notifikasi. Itu ditemukan lewat uji nyata ke FCM, bukan
   * dari membaca dokumentasi.
   */
  channelId: string;
}

/**
 * Pengirim notifikasi lewat Firebase Cloud Messaging HTTP v1.
 *
 * Ditulis sendiri tanpa `firebase-admin` supaya tidak menarik pohon dependensi
 * besar ke backend yang sengaja ramp. Yang dipakai hanya dua langkah: tukar
 * service account jadi access token, lalu POST ke endpoint FCM. `fetch` global
 * Node 20 yang dipakai, bukan library tambahan.
 *
 * Kalau kredensial FCM belum diisi di `.env`, semua pengiriman menjadi no-op
 * yang dilog sekali. Aplikasi harus tetap jalan normal: notifikasi yang hilang
 * jauh lebih ringan daripada server yang gagal start.
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);

  private accessToken: string | null = null;
  private accessTokenBerlakuSampai = 0;
  private sudahPeringatkanKonfigurasi = false;

  private projectId(): string {
    return process.env.FCM_PROJECT_ID ?? '';
  }

  private clientEmail(): string {
    return process.env.FCM_CLIENT_EMAIL ?? '';
  }

  /**
   * Private key milik service account.
   *
   * PENTING: isi dari file JSON Firebase memakai `\n` sebagai dua karakter,
   * bukan baris baru. Kalau tidak diganti, `createSign` membaca kunci yang
   * rusak dan errornya tidak mendekati penyebabnya sama sekali.
   */
  private privateKey(): string {
    const raw = process.env.FCM_PRIVATE_KEY ?? '';
    return raw.replace(/\\n/g, '\n');
  }

  private konfigurasiLengkap(): boolean {
    return (
      this.projectId() !== '' &&
      this.clientEmail() !== '' &&
      this.privateKey() !== ''
    );
  }

  /**
   * Tukar service account jadi access token berumur 1 jam.
   *
   * Dipakai JWT bertanda tangan RS256 yang diklaim ke endpoint token Google,
   * lalu disimpan di memory supaya tidak perlu tukar ulang tiap notifikasi.
   */
  private async ambilAccessToken(): Promise<string> {
    const now = Date.now();
    if (
      this.accessToken &&
      this.accessTokenBerlakuSampai - now > AMAN_SISA_MS
    ) {
      return this.accessToken;
    }

    const nowDetik = Math.floor(now / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const klaim = {
      iss: this.clientEmail(),
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowDetik,
      exp: nowDetik + 3600,
    };

    const encode = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');
    const bagian = `${encode(header)}.${encode(klaim)}`;

    const pengenal = createSign('RSA-SHA256')
      .update(bagian)
      .sign(this.privateKey());

    const assertion = `${bagian}.${pengenal.toString('base64url')}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!res.ok) {
      const teks = await res.text();
      throw new Error(`oauth2.googleapis.com ${res.status}: ${teks}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    this.accessTokenBerlakuSampai = now + data.expires_in * 1000;
    return this.accessToken;
  }

  /** Kirim satu pesan ke satu token. Tidak pernah melempar error. */
  async kirim(token: string, pesan: PesanNotifikasi): Promise<HasilKirim> {
    if (!this.konfigurasiLengkap()) {
      if (!this.sudahPeringatkanKonfigurasi) {
        this.sudahPeringatkanKonfigurasi = true;
        this.logger.warn(
          'FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY belum diisi di .env ' +
            '- notifikasi push tidak dikirim.',
        );
      }
      return {
        ok: false,
        status: null,
        kode: null,
        pesan: 'Kredensial FCM belum diisi',
        tokenMati: false,
      };
    }

    let akses: string;
    try {
      akses = await this.ambilAccessToken();
    } catch (e) {
      const pesanError = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Gagal tukar service account jadi access token: ${pesanError}`,
      );
      return {
        ok: false,
        status: null,
        kode: null,
        pesan: pesanError,
        tokenMati: false,
      };
    }

    const body = {
      message: {
        token,
        notification: { title: pesan.judul, body: pesan.isi },
        data: pesan.data ?? {},
        android: {
          // 'HIGH' supaya notifikasi muncul heads-up. Tanpa itu, notifikasi
          // bisa masuk diam-diam saat HP sedang dipakai.
          priority: 'HIGH',
          notification: {
            channel_id: pesan.channelId,
            // Tanpa ini, notifikasi tetap muncul, tapi importance channel yang
            // menentukan suara dan getaran.
            notification_priority: 'PRIORITY_HIGH',
          },
        },
      },
    };

    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.projectId()}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${akses}`,
          },
          body: JSON.stringify(body),
        },
      );

      const teks = await res.text();
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          kode: null,
          pesan: 'Terkirim',
          tokenMati: false,
        };
      }

      // FCM membalas error dalam bentuk JSON. Kode yang kita perlukan ada di
      // `error.details[].errorCode` (tipe FcmError), BUKAN di `error.status`:
      // untuk token yang sudah tidak berlaku, `status` menuliskan
      // INVALID_ARGUMENT sementara `errorCode` menuliskan UNREGISTERED.
      //
      // Bedanya penting. Dulu kode asli dibaca dari `status`, dan
      // INVALID_ARGUMENT langsung dianggap "token mati" — padahal status itu
      // juga dipakai kalau request-nya sendiri yang salah. Akibatnya satu field
      // yang tidak dikenal membuat SEMUA token yang sah ikut terhapus.
      let kode: string | null = null;
      let status: string | null = null;
      let pesanError = teks;
      try {
        const parsed = JSON.parse(teks) as {
          error?: {
            status?: string;
            message?: string;
            details?: { errorCode?: string }[];
          };
        };
        status = parsed.error?.status ?? null;
        kode =
          parsed.error?.details?.find((d) => d.errorCode)?.errorCode ??
          status ??
          null;
        pesanError = parsed.error?.message ?? teks;
      } catch {
        // Bukan JSON. Pesan mentahnya dipakai, tapi jangan sampai melempar.
      }

      // Hanya dua kode ini yang benar-benar berarti token tidak akan pernah
      // dipakai lagi. INVALID_ARGUMENT sengaja TIDAK ikut: kode itu ambigu,
      // bisa berarti token rusak ATAU request kita yang salah, dan menghapus
      // token karena kesalahan kita sendiri akan mematikan notifikasi untuk
      // semua orang.
      const tokenMati = kode === 'UNREGISTERED' || kode === 'SENDER_ID_MISMATCH';

      return {
        ok: false,
        status: res.status,
        kode: kode ? `${kode}${status && status !== kode ? ` (status ${status})` : ''}` : null,
        pesan: pesanError,
        tokenMati,
      };
    } catch (e) {
      const pesanError = e instanceof Error ? e.message : String(e);
      this.logger.error(`Gagal menghubungi FCM: ${pesanError}`);
      return {
        ok: false,
        status: null,
        kode: null,
        pesan: pesanError,
        tokenMati: false,
      };
    }
  }
}
