import { IsString, IsNotEmpty } from 'class-validator';

export class PinUninstallDto {
  @IsString()
  @IsNotEmpty()
  pin: string;
}