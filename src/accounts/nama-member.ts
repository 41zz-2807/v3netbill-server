/**
 * Batas panjang nama member.
 *
 * ⚠️ Nama member adalah **kredensial login**-nya: `session.service.ts` mencari
 * akun dengan mencocokkan kolom `nama` persis (`cariAkunAktif` tidak memakai
 * `mode: 'insensitive'`). Jadi nama pendek itu bukan hanya masalah tampilan —
 * dia membuat nama yang mudah ditebak orang lain di warnet.
 *
 * Batas atas 40 mengikuti panjang kolom di database dan sudah dipakai di form
 * aplikasi. Batas bawah 4 adalah keputusan operator: nama 1-3 karakter terlalu
 * pendek untuk dibedakan.
 *
 * ⚠️ Member yang sudah terlanjur dibuat **tidak** disentuh. Validasi ini hanya
 * berlaku untuk pembuatan baru, jadi nama lama yang lebih pendek tetap bisa
 * login seperti biasa.
 */
export const MIN_KARAKTER_NAMA = 4;
export const MAKS_KARAKTER_NAMA = 40;
