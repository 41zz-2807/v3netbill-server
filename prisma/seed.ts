import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  await prisma.setting.upsert({
    where: { key: 'harga_per_menit' },
    update: {},
    create: {
      key: 'harga_per_menit',
      value: '150',
    },
  })

  await prisma.setting.upsert({
    where: { key: 'grace_period_detik' },
    update: {},
    create: {
      key: 'grace_period_detik',
      value: '180',
    },
  })

  console.log('Seed completed')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })