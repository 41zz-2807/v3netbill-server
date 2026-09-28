// Kunci Setting untuk PIN bypass/maintenance agent.
//
// File terpisah supaya settings.service.ts dan session.gateway.ts sama-sama bisa
// mengimpornya tanpa circular import, sama seperti otp-keys.ts.

export const BYPASS_PIN_HASH_KEY = 'pin_bypass_hash';
