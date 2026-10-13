// Kunci Setting untuk pembaruan otomatis agent (self-update).
//
// ⚠️ DEFAULT-nya FALSE, dan itu bukan kelalaian.
//
// Agent produksi yang sekarang terpasang TIDAK punya kode pembaruan otomatis,
// jadi mereka tidak akan pernah tersentuh. Kode ini baru ada di MSI 1.0.26.0
// ke atas, dan meski sudah terpasang pun agent tidak akan mengerjakan apa pun
// sampai sakelar ini benar-benar dinyalakan operator dari halaman Pengaturan.
//
// Tiga lapis sebelum satu perintah install bisa jalan:
//   1. Agent harus versi yang MEMILIKI kode update (>= 1.0.26.0).
//   2. Setting ini harus "true".
//   3. PC harus sedang TIDAK ada sesi berjalan dan tidak sedang maintenance.
//
// Lapis ketiga yang paling penting: pembaruan di tengah sesi pelanggan bisa
// memutus penagihan.

export const AGENT_AUTO_UPDATE_KEY = 'agent_auto_update';

export const AUTO_UPDATE_KEYS = [AGENT_AUTO_UPDATE_KEY];
