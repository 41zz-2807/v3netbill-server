-- AlterTable
ALTER TABLE "Pc" ADD COLUMN     "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoUpdatePercen" INTEGER,
ADD COLUMN     "autoUpdatePesan" TEXT,
ADD COLUMN     "autoUpdateWaktu" TIMESTAMP(3);
