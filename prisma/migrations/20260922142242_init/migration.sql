-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'KASIR');

-- CreateEnum
CREATE TYPE "PcStatus" AS ENUM ('IDLE', 'ACTIVE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('VOUCHER', 'MEMBER');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('BERJALAN', 'SELESAI', 'DISTOP');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('BELI_BARU', 'TOPUP');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pc" (
    "id" TEXT NOT NULL,
    "namaPc" TEXT NOT NULL,
    "ipClient" TEXT NOT NULL,
    "status" "PcStatus" NOT NULL DEFAULT 'IDLE',
    "lastHeartbeatAt" TIMESTAMP(3),
    "agentToken" TEXT NOT NULL,

    CONSTRAINT "Pc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "tipe" "AccountType" NOT NULL,
    "kodeUnik" TEXT,
    "nama" TEXT,
    "passwordHash" TEXT NOT NULL,
    "sisaWaktuDetik" INTEGER NOT NULL DEFAULT 0,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "pcId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "waktuMulai" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waktuSelesai" TIMESTAMP(3),
    "durasiTerpakaiDetik" INTEGER NOT NULL DEFAULT 0,
    "status" "SessionStatus" NOT NULL DEFAULT 'BERJALAN',
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "nominal" INTEGER NOT NULL,
    "durasiMenit" INTEGER NOT NULL,
    "jenis" "TransactionType" NOT NULL,
    "kasirId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyReport" (
    "id" TEXT NOT NULL,
    "tanggal" DATE NOT NULL,
    "totalLogin" INTEGER NOT NULL DEFAULT 0,
    "voucherTerbentuk" INTEGER NOT NULL DEFAULT 0,
    "voucherTopup" INTEGER NOT NULL DEFAULT 0,
    "memberTerbentuk" INTEGER NOT NULL DEFAULT 0,
    "memberTopup" INTEGER NOT NULL DEFAULT 0,
    "pendapatanVoucher" INTEGER NOT NULL DEFAULT 0,
    "pendapatanMember" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Pc_agentToken_key" ON "Pc"("agentToken");

-- CreateIndex
CREATE UNIQUE INDEX "Account_kodeUnik_key" ON "Account"("kodeUnik");

-- CreateIndex
CREATE UNIQUE INDEX "DailyReport_tanggal_key" ON "DailyReport"("tanggal");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_pcId_fkey" FOREIGN KEY ("pcId") REFERENCES "Pc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_kasirId_fkey" FOREIGN KEY ("kasirId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
