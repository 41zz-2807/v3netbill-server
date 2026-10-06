-- CreateTable
CREATE TABLE "Teknisi" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "aktif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Teknisi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SesiTeknisi" (
    "id" TEXT NOT NULL,
    "pcId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "mulaiAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selesaiAt" TIMESTAMP(3),

    CONSTRAINT "SesiTeknisi_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Teknisi_username_key" ON "Teknisi"("username");

-- CreateIndex
CREATE INDEX "SesiTeknisi_pcId_idx" ON "SesiTeknisi"("pcId");

-- CreateIndex
CREATE INDEX "SesiTeknisi_username_idx" ON "SesiTeknisi"("username");
