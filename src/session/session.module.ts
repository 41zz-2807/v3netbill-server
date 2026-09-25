import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionGateway } from './session.gateway.js';
import { SessionService } from './session.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
    }),
  ],
  providers: [SessionGateway, SessionService],
  exports: [SessionService, SessionGateway],
})
export class SessionModule {}