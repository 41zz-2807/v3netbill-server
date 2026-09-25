import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SessionModule } from '../session/session.module.js';

@Module({
  imports: [PrismaModule, SessionModule],
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}