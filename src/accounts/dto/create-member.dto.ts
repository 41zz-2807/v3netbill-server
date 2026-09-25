import { IsString, IsNotEmpty, MinLength, IsInt, Min, IsNumber } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateMemberDto {
  @IsString()
  @IsNotEmpty()
  nama: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  password: string;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(500)
  nominal: number;
}