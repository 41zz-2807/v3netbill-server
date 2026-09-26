import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActivityLogService, PaginatedLogs } from './activity-log.service.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '@prisma/client';

@Controller('activity-log')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.KASIR)
export class ActivityLogController {
  constructor(private readonly service: ActivityLogService) {}

  @Get()
  async find(
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ): Promise<PaginatedLogs> {
    const lim = limit ? parseInt(limit, 10) : 30;
    const pg = page ? parseInt(page, 10) : 1;
    return this.service.findByDay(new Date(), pg, lim);
  }

  @Get('today')
  async findToday(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<PaginatedLogs> {
    const pg = page ? parseInt(page, 10) : 1;
    const lim = limit ? parseInt(limit, 10) : 30;
    return this.service.findByDay(new Date(), pg, lim);
  }
}
