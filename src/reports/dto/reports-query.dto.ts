import { IsOptional, IsDateString } from 'class-validator';

export class ReportsQueryDto {
  @IsOptional()
  @IsDateString()
  dari?: string;

  @IsOptional()
  @IsDateString()
  sampai?: string;
}