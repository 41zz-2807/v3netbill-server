import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { writeFileSync } from 'node:fs'
const prisma = new PrismaClient()
const u = await prisma.user.findFirst({ where: { role: 'ADMIN' } })
writeFileSync('/tmp/tk3', jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '4h' }))
await prisma.$disconnect()
