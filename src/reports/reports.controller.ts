import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service.js';
import { ReportsQueryDto } from './dto/reports-query.dto.js';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('today')
  async today() {
    return this.reportsService.getToday();
  }

  @Get('daily')
  async daily(@Query() query: ReportsQueryDto) {
    return this.reportsService.getDaily(query);
  }

  @Get('range')
  async range(@Query() query: ReportsQueryDto) {
    return this.reportsService.getRange(query);
  }
}