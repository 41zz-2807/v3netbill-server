import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { AccountsService } from './accounts.service.js';
import { CreateVoucherDto } from './dto/create-voucher.dto.js';
import { CreateMemberDto } from './dto/create-member.dto.js';
import { TopupDto } from './dto/topup.dto.js';
import { KoreksiDto } from './dto/koreksi.dto.js';
import { BatalTransaksiDto } from './dto/batal-transaksi.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { AccountsQueryDto } from './dto/accounts-query.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post('voucher')
  async createVoucher(
    @Body() createVoucherDto: CreateVoucherDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.accountsService.createVoucher(createVoucherDto, user.id);
  }

  @Post('member')
  async createMember(
    @Body() createMemberDto: CreateMemberDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.accountsService.createMember(createMemberDto, user.id);
  }

  @Post(':id/topup')
  async topup(
    @Param('id') id: string,
    @Body() topupDto: TopupDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.accountsService.topup(id, topupDto, user.id);
  }

  @Post(':id/koreksi')
  async koreksi(
    @Param('id') id: string,
    @Body() koreksiDto: KoreksiDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.accountsService.koreksi(id, koreksiDto, user.id);
  }

  @Post(':id/batal-transaksi')
  async batalTransaksi(
    @Param('id') id: string,
    @Body() batalTransaksiDto: BatalTransaksiDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.accountsService.batalTransaksi(id, batalTransaksiDto, user.id);
  }

  @Patch(':id/password')
  async changePassword(
    @Param('id') id: string,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    return this.accountsService.changePassword(id, changePasswordDto);
  }

  @Post(':id/revoke')
  async revoke(@Param('id') id: string) {
    return this.accountsService.revoke(id);
  }

  @Get()
  async findAll(@Query() query: AccountsQueryDto) {
    return this.accountsService.findAll(query);
  }
}