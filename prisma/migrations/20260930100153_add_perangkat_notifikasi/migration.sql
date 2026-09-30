-- CreateTable
CREATE TABLE "Perangkat" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Perangkat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Perangkat_token_key" ON "Perangkat"("token");

-- CreateIndex
CREATE INDEX "Perangkat_userId_idx" ON "Perangkat"("userId");

-- AddForeignKey
ALTER TABLE "Perangkat" ADD CONSTRAINT "Perangkat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
