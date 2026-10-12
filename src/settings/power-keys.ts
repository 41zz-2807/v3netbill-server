// Kunci Setting untuk pengaturan daya PC client (sleep / screen off / screensaver).
//
// Dipisah ke file sendiri, sama seperti `otp-keys.ts` dan `nextcloud-keys.ts`,
// supaya settings.service.ts dan session.gateway.ts sama-sama bisa
// mengimpornya tanpa circular import.
//
// Nilai disimpan sebagai string "true" / "false" (semua nilai Setting adalah
// string). Default-nya "true" — PC warnet tidak boleh tidur, layar tidak boleh
// mati sendiri, dan screensaver tidak boleh muncul, karena ketiganya membuat
// pelanggan berhenti billing tanpa tahu kenapa.

export const AGENT_PREVENT_SLEEP_KEY = 'agent_prevent_sleep';

export const POWER_KEYS = [AGENT_PREVENT_SLEEP_KEY];
