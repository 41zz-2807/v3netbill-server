/**
 * Password bawaan untuk voucher dan member yang baru dibuat.
 *
 * Dulu tiap voucher mendapat password angka acak 4 digit. Itu menyulitkan
 * kasir karena harus mencatat kode dan password-nya terpisah, dan pelanggan
 * sering kehilangan kertasnya. Sekarang semua akun baru langsung memakai
 * password yang sama, sehingga cukup kode voucher saja untuk masuk.
 *
 * Password ini bisa diganti sendiri dari layar PC lewat tombol "Buat
 * Password" di agent, jadi tidak mengurangi fleksibilitas.
 */
export const PASSWORD_DEFAULT = '0000';

/**
 * Panjang minimum password.
 *
 * Dipakai saat validasi password baru dari agent, dan juga oleh form
 * web/mobile supaya penolakan terjadi di sisi server dan di sisi klien
 * dengan aturan yang sama.
 */
export const PANJANG_PASSWORD_MIN = 4;
