import { IsString, IsNotEmpty, MinLength, MaxLength, IsEnum } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  username: string;

  // LoginDto hanya mewajibkan 4 karakter (akun lama masih boleh login).
  // User baru minimal 6 supaya tidak seempel itu.
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(100)
  password: string;

  @IsEnum(Role)
  role: Role;
}
