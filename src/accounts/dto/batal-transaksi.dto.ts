import { IsString, MinLength } from 'class-validator';

export class BatalTransaksiDto {
  @IsString()
  @MinLength(1)
  transactionId: string;
}