// Kunci Setting untuk konfigurasi OTP Telegram agent.
//
// Dipisah ke file sendiri supaya settings.service.ts dan session.gateway.ts sama-sama
// bisa mengimpornya tanpa circular import (gateway sudah mengimpor SettingsModule
// untuk push config, dan service mengimpor gateway).

export const OTP_BOT_TOKEN_KEY = 'agent_otp_bot_token';
export const OTP_CHAT_ID_KEY = 'agent_otp_chat_id';
export const OTP_KEYS = [OTP_BOT_TOKEN_KEY, OTP_CHAT_ID_KEY];
