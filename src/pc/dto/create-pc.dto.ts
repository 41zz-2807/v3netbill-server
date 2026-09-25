import { IsString, IsNotEmpty, IsIP } from 'class-validator';

export class CreatePcDto {
  @IsString()
  @IsNotEmpty()
  namaPc: string;

  @IsString()
  @IsNotEmpty()
  @IsIP()
  ipClient: string;
}