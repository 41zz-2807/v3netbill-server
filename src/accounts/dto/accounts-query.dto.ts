import { IsOptional, IsEnum } from 'class-validator';
import { AccountType, AccountStatus } from '@prisma/client';

export class AccountsQueryDto {
  @IsOptional()
  @IsEnum(AccountType)
  tipe?: AccountType;

  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;
}