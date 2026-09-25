import { Controller, Get, Query } from '@nestjs/common';
import { TransactionsService } from './transactions.service.js';
import { TransactionsQueryDto } from './dto/transactions-query.dto.js';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  async findAll(@Query() query: TransactionsQueryDto) {
    return this.transactionsService.findAll(query);
  }
}