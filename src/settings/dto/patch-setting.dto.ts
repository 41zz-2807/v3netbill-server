import { IsString, IsNotEmpty } from 'class-validator';

export class PatchSettingDto {
  @IsString()
  @IsNotEmpty()
  key: string;

  @IsString()
  @IsNotEmpty()
  value: string;
}