import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { PcService } from './pc.service.js';
import { SessionService } from '../session/session.service.js';
import { CreatePcDto } from './dto/create-pc.dto.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '@prisma/client';

@Controller('pcs')
export class PcController {
  constructor(
    private readonly pcService: PcService,
    private readonly sessionService: SessionService,
  ) {}

  @Get()
  async findAll() {
    return this.pcService.findAll();
  }

  @Post()
  @Roles(Role.ADMIN)
  async create(@Body() createPcDto: CreatePcDto) {
    return this.pcService.create(createPcDto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  async remove(@Param('id') id: string) {
    return this.pcService.remove(id);
  }

  @Post(':id/unlock')
  @Roles(Role.ADMIN)
  async unlock(@Param('id') id: string) {
    return this.sessionService.unlockPc(id);
  }
}