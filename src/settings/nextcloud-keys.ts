// Kunci Setting untuk konfigurasi Nextcloud (tujuan upload log agent).
//
// Dipisah ke file sendiri, sama seperti `otp-keys.ts`, supaya settings.service.ts
// dan session.gateway.ts sama-sama bisa mengimpornya tanpa circular import
// (gateway sudah mengimpor SettingsModule untuk push config, dan service
// mengimpor gateway).
//
// ⚠️ Nilai-nilai ini berisi password Nextcloud. `GET /api/settings`
// mengembalikan SELURUH tabel Setting, jadi password ini ikut terlihat di sana —
// itu konsekuensi dari masih memakai satu endpoint untuk semua setting, dan
// sudah sama berlaku untuk `agent_otp_bot_token` serta kedua hash PIN.
// Jangan pernah mencetak isi `/api/settings` ke dokumen mana pun.

export const NEXTCLOUD_URL_KEY = 'nextcloud_url';
export const NEXTCLOUD_USER_KEY = 'nextcloud_user';
export const NEXTCLOUD_PASSWORD_KEY = 'nextcloud_password';
export const NEXTCLOUD_FOLDER_KEY = 'nextcloud_folder';

/** Folder Nextcloud yang dipakai kalau setting kosong. */
export const NEXTCLOUD_FOLDER_BAVAAN = 'log-pc-warnet';

export const NEXTCLOUD_KEYS = [
  NEXTCLOUD_URL_KEY,
  NEXTCLOUD_USER_KEY,
  NEXTCLOUD_PASSWORD_KEY,
  NEXTCLOUD_FOLDER_KEY,
];
