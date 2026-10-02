import { Module } from '@nestjs/common';
import { DiagnosaService } from './diagnosa.service.js';
import { DiagnosaController } from './diagnosa.controller.js';

@Module({
  controllers: [DiagnosaController],
  providers: [DiagnosaService],
})
export class DiagnosaModule {}