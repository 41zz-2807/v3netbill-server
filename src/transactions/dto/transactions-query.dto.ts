import { IsOptional, IsString, IsDateString } from 'class-validator';

export class TransactionsQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsDateString()
  dari?: string;

  @IsOptional()
  @IsDateString()
  sampai?: string;
}