-- Satu akun hanya boleh punya satu sesi BERJALAN. Penjaga di aplikasi bisa
-- kalah balapan (dua permintaan bersamaan); indeks parsial ini yang menutupnya.
CREATE UNIQUE INDEX "Session_accountId_berjalan_key" ON "Session" ("accountId") WHERE "status" = 'BERJALAN';
