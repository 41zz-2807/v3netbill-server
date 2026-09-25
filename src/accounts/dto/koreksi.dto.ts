import { IsInt, Min, IsNumber } from 'class-validator';
import { Transform } from 'class-transformer';

export class KoreksiDto {
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(500)
  nominal: number;
}