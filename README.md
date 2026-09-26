# v3Netbill — Backend

API + WebSocket untuk sistem billing warnet. NestJS 12 (ESM), Prisma 5.22, PostgreSQL 15.

> Semua perintah npm/npx/node **wajib** dijalankan di dalam container — lihat [Cara Menjalankan](#cara-menjalankan).

---

## Deskripsi Singkat

Backend ini memegang seluruh logika billing: autentikasi kasir/admin, management PC, voucher &
member, sesi pemakaian PC secara real-time lewat WebSocket, laporan, pengaturan, dan jejak
aktivitas. Frontend (React/Vite) dan Agent Client (Windows/.NET) adalah klien dari API ini.

---

## Konvensi Penting

| Aturan | Nilai |
|---|---|
| Prefix global | `/api` — semua REST endpoint diawali `/api` |
| WebSocket | namespace `/session`, port 3000, CORS `*` |
| Autentikasi REST | JWT `Authorization: Bearer <token>` |
| Autentikasi WS | `token` (dashboard, JWT) atau `pcId` + `agentToken` (agent) di `handshake.query` |
| Role | `ADMIN` (penuh) dan `KASIR` (terbatas) |
| DB | PostgreSQL 15, 8 model, 6 enum (lihat `prisma/schema.prisma`) |

> **Guard global** (`APP_GUARD`) dibuat bypass untuk context `ws`, karena agent memakai token PC
> (`agentToken`) bukan JWT. `HttpExceptionFilter` juga hanya menangani context `http`.

---

## Daftar Modul

| Modul | Path | Fungsi |
|---|---|---|
| `auth` | `src/auth/` | Login JWT, `JwtStrategy` |
| `pc` | `src/pc/` | CRUD PC, generate `agentToken`, unlock |
| `accounts` | `src/accounts/` | Voucher & member: beli, topup, koreksi, void, password, revoke |
| `transactions` | `src/transactions/` | Riwayat transaksi |
| `session` | `src/session/` | **Inti sistem** — gateway WebSocket + logika sesi real-time |
| `reports` | `src/reports/` | Rekap harian & rentang (dihitung ulang on-read) |
| `laporan` | `src/laporan/` | Laporan tutup hari: PDF + email + Telegram (cron) |
| `settings` | `src/settings/` | Tarif, password, upload installer/wallpaper, backup, PIN uninstall |
| `activity-log` | `src/activity-log/` | Jejak aktivitas (paginate + today) |
| `common` | `src/common/` | Guards, decorators, exception filter |
| `prisma` | `src/prisma/` | `PrismaService` (module global) |

---

## Endpoint REST

Semua di bawah ini perlu JWT kecuali yang ditandai `@Public()`.

### Auth
| Method | Path | Keterangan |
|---|---|---|
| POST | `/api/auth/login` | Login → `{ access_token, role }` |

### PC
| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/pcs` | Daftar PC |
| POST | `/api/pcs` | Tambah PC (ADMIN). `ipClient` opsional — auto dari koneksi agent |
| DELETE | `/api/pcs/:id` | Hapus PC (ditolak bila ada sesi `BERJALAN`) |
| POST | `/api/pcs/:id/unlock` | Unlock manual PC yang macet |

### Accounts (Voucher & Member)
| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/accounts` | Daftar akun |
| POST | `/api/accounts/voucher` | Beli voucher baru |
| POST | `/api/accounts/member` | Buat member baru |
| POST | `/api/accounts/:id/topup` | Topup (member) |
| POST | `/api/accounts/:id/koreksi` | Koreksi transaksi |
| POST | `/api/accounts/:id/batal-transaksi` | Void transaksi |
| PATCH | `/api/accounts/:id/password` | Set password manual |
| POST | `/api/accounts/:id/revoke` | Nonaktifkan akun |

### Transactions
| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/transactions` | Riwayat transaksi |

### Reports
| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/reports/today` | Rekap hari ini |
| GET | `/api/reports/daily?dari&sampai` | Rekap harian |
| GET | `/api/reports/range?dari&sampai` | Rekap rentang (maks 366 hari) |

> Rekap dihitung ulang on-read dari `Transaction` + `Session`, lalu `upsert` ke `DailyReport`
> dengan `tanggal` unik. Constraint: `sampai >= dari`, rentang maksimal 366 hari.

### Laporan Tutup Hari
| Method | Path | Keterangan |
|---|---|---|
| POST | `/api/laporan/kirim-tutup-hari` | Kirim manual (ADMIN) |

### Settings
| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/settings` | Semua setting (map key-value) |
| PATCH | `/api/settings` | Ubah setting `{key,value}` (ADMIN) |
| PATCH | `/api/settings/password` | Ganti password sendiri |
| POST | `/api/settings/installer` | Upload installer `.exe/.msi` (ADMIN, maks 200MB) |
| GET | `/api/settings/installer` | Download installer |
| POST | `/api/settings/wallpaper` | Upload wallpaper (ADMIN, maks 10MB) |
| GET | `/api/settings/wallpaper` | Ambil wallpaper |
| POST | `/api/settings/backup` | Backup DB via `pg_dump` |
| GET | `/api/settings/backup/last` | Info backup terakhir |
| GET | `/api/settings/backup/list` | Daftar semua backup |
| GET | `/api/settings/backup/download` | Download file backup |
| PATCH | `/api/settings/pin-uninstall` | Set PIN uninstall (ADMIN) |
| POST | `/api/settings/verify-pin` | Verifikasi PIN (**`@Public()`** — tanpa JWT, pakai `pcId`+`agentToken`) |

### Activity Log
| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/activity-log?limit&cursor` | Paginate |
| GET | `/api/activity-log/today` | Activity hari ini |

---

## WebSocket (namespace `/session`)

### Dikirim oleh agent / dashboard
| Event | Pengirim | Isi |
|---|---|---|
| `agent:register` | agent | `{ pcId, agentToken }` |
| `agent:heartbeat` | agent | `{ pcId }` |
| `client:login_request` | overlay | Login dari layar PC → `client:login_result` |
| `client:stop_session` | overlay | Stop sesi dari PC |
| `dashboard:subscribe` | dashboard | Subscribe room `dashboard` |
| `dashboard:start_pc` | dashboard | Jalankan PC |
| `dashboard:start_voucher` | dashboard | Mulai sesi pakai voucher/member |
| `dashboard:lock_pc` | dashboard | Kunci PC |
| `dashboard:shutdown_pc` | dashboard | Matikan PC |

### Dikirim server
| Event | Ke | Isi |
|---|---|---|
| `client:login_result` | overlay | `{ success, sessionId?, message? }` |
| `session:start` | agent | Sesi dimulai |
| `session:tick` | agent | `{ sisaDetik }` — tick tiap 1 detik |
| `session:stop` | agent | `{ alasan }` |
| `admin:lock` | agent | `{ pcId }` |
| `admin:shutdown` | agent | `{ pcId }` |
| `dashboard:pc_update` | room `dashboard` | `{ pcs: [...] }` — array detail PC + sesi aktif + sisa detik |
| `dashboard:log` | room `dashboard` | Jejak aktivitas (`session:started`, `session:stopped`, `pc_locked`, `pc_unlocked`, `pc_shutdown`, `transaction:created`) |

> **Penting**: `dashboard:pc_update` mengirim array `pcs` berisi detail session aktif + sisa detik
> — **bukan** objek kosong `{}`.

---

## Cron Jobs

| Nama | Jadwal | Fungsi |
|---|---|---|
| `auto-backup` | 01:00 | `pg_dump` + bersihkan backup lama (retensi 30 hari) |
| `cleanup-activity-logs` | 02:00 | Hapus activity log lebih dari 30 hari |
| `tutup-hari-laporan` | 23:30 WIB | Rekap hari sebelumnya → PDF + email + Telegram (`timeZone: Asia/Jakarta`) |

> **Batas hari bisnis = 23:30 WIB** (hari T = [23:30 T-1, 23:30 T)). Rekap nol dihitung setelah
> batas ini.

---

## Logika Bisnis Inti

- **Server = sumber kebenaran waktu.** Sesi di-tick tiap 1 detik; durasi tidak bergantung pada
  koneksi PC.
- **Grace period disconnect** = `Setting.grace_period_detik` (default 180 detik). Auto-stop dengan
  alasan `disconnect_timeout` bila grace habis.
- **Alasan stop & refund:**
  - `habis` → sisa waktu di-reset ke 0 (voucher sekali pakai, tidak bisa dipakai ulang)
  - `manual` / `disconnect_timeout` → refund sisa waktu
- **Password voucher** = 4 digit angka (`crypto.randomInt(0,10000).padStart(4,'0')`, boleh leading
  zero). Password manual via `PATCH /accounts/:id/password` bebas formatnya.
- **Nominal** harus kelipatan 500. Durasi = `floor((nominal / harga_per_menit) * 60)` detik.
- **IP PC** (`Pc.ipClient`) adalah data **tampilan** saja, diisi otomatis dari koneksi agent.
  Identitas PC selalu `pcId` + `agentToken`. Lihat `docs/DETEKSI-IP.md`.

---

## Prisma

- Schema: `prisma/schema.prisma` — 8 model, 6 enum.
- Seed: `prisma/seed.ts` (mis. `harga_per_menit=150`, `grace_period_detik=180`).
- Migrasi **applied (4)**: `20260922142242_init`, `20260925072311_add_transaction_koreksi`,
  `20260925072645_add_transaction_void`, `20260925163314_add_activity_log`.
- Buat migrasi baru: `docker compose exec -T v3netbill-backend npx prisma migrate dev --name <nama>`

> Prisma **wajib** di-pin versi 5.22.x (`@prisma/client` + `prisma`). Jangan upgrade ke 7.x —
> format schema tidak kompatibel.

---

## Cara Menjalankan

Semua perintah dijalankan dari root project (`/home/warnet/docker/v3netbill`) lewat Docker
Compose — **jangan** pernah jalankan npm/npx/node di host.

```bash
# build backend
docker compose exec -T v3netbill-backend npm run build

# jalankan stack
docker compose up -d

# log
docker compose logs -f v3netbill-backend
```

Contoh akses:

```bash
curl http://localhost:3000/api/reports/today -H "Authorization: Bearer <token>"
```

---

## Testing

- **REST**: `curl` dari host ke `http://localhost:3000`.
- **WebSocket / inspeksi DB**: buat file `.mjs` sementara, `docker cp` ke container, jalankan
  `node /app/x.mjs` memakai `socket.io-client` + `PrismaClient`. Bersihkan file test setelah.
- Selalu cek `docker compose logs v3netbill-backend` untuk memastikan 0 error.

> **Known issue (pre-existing, bukan gangguan)**: `test/app.e2e-spec.ts` gagal di typecheck dengan
> `Cannot find module 'supertest/types'`. Build (`npm run build`) tetap 0 error. Filter saat
> typecheck manual: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v supertest`.

---

## Relasi Antar File

Project ini `"type": "module"` + `moduleResolution: nodenext` — **semua import antar file backend WAJIB**
memakai ekstensi `.js` (contoh: `import { X } from './x.service.js'`). Jangan diubah ke
Node16/CommonJS.

---

## Link Dokumentasi Lain

| Dokumen | Isi |
|---|---|
| `../AGENTS.md` | Aturan kerja agent AI, status fase, catatan per fase |
| `../CONVERSATION_LOG.md` | Log kerja kronologis |
| `../docs/DEPLOYMENT.md` | Topologi jaringan, Docker, Cloudflare Tunnel |
| `../docs/DETEKSI-IP.md` | Mekanisme deteksi IP PC & batasan topologi |
| `../frontend/README.md` | Dokumentasi frontend |
| `../v3NetbillAgent/README.md` | Dokumentasi Agent Client (Windows) |
