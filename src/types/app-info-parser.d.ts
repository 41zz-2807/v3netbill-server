/**
 * Tipe untuk paket `app-info-parser`.
 *
 * Paket ini tidak menyediakan berkas `.d.ts` di npm, jadi deklarasi minimalnya
 * kita tulis sendiri. Hanya bagian yang benar-benar dipakai.
 *
 * CATATAN PENTING: `parse()` mengembalikan **Promise**. Dipanggil tanpa `await`
 * hasilnya objek Promise kosong, dan `versionCode` selalu `undefined` — itu
 * bukan berarti APK-nya rusak.
 */
declare module 'app-info-parser' {
  interface ApkInfo {
    package?: string;
    versionCode?: number | string;
    versionName?: string;
  }

  class AppInfoParser {
    constructor(file: string);
    parse(): Promise<ApkInfo>;
  }

  export = AppInfoParser;
}
