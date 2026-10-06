-- CreateTable
CREATE TABLE "UptimePc" (
    "pcId" TEXT NOT NULL,
    "tanggal" DATE NOT NULL,
    "detikOnline" INTEGER NOT NULL DEFAULT 0,
    "dihitungSampai" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UptimePc_pkey" PRIMARY KEY ("pcId","tanggal")
);

-- CreateIndex
CREATE INDEX "UptimePc_tanggal_idx" ON "UptimePc"("tanggal");

-- AddForeignKey
ALTER TABLE "UptimePc" ADD CONSTRAINT "UptimePc_pcId_fkey" FOREIGN KEY ("pcId") REFERENCES "Pc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
