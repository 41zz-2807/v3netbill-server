import { IsString, IsNotEmpty } from 'class-validator';

export class VerifyPinDto {
  @IsString()
  @IsNotEmpty()
  pcId: string;

  @IsString()
  @IsNotEmpty()
  agentToken: string;

  @IsString()
  @IsNotEmpty()
  pin: string;
}