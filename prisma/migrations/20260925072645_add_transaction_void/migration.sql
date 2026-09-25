-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "dibatalkan" TIMESTAMP(3),
ADD COLUMN     "dibatalkanOleh" TEXT,
ADD COLUMN     "durasiDetik" INTEGER NOT NULL DEFAULT 0;
