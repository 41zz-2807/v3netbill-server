import { Controller, Post, Get, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { LogBillingService } from '../log-billing/log-billing.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Role } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly logBilling: LogBillingService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    const hasil = await this.authService.login(loginDto);

    // Login dicatat setelah berhasil, bukan sebelum: kalau gagal, passwordnya
    // salah dan itu tidak menarik untuk log billing.
    //
    // `username` diambil dari input, bukan dari hasil service, supaya bentuk
    // jawaban `POST /auth/login` tidak berubah. Karena login baru berhasil,
    // nilai input itu sama dengan nama akun yang sebenarnya.
    this.logBilling.tulis('auth:login', {
      username: loginDto.username.trim(),
      role: hasil.role,
    });

    return hasil;
  }

  /** Semua user dipakai login, jadi hanya ADMIN yang boleh menambah. */
  @Roles(Role.ADMIN)
  @Post('users')
  async createUser(@Body() createUserDto: CreateUserDto) {
    return this.authService.createUser(createUserDto);
  }

  @Roles(Role.ADMIN)
  @Get('users')
  async listUsers() {
    return this.authService.listUsers();
  }

  @Roles(Role.ADMIN)
  @Delete('users/:id')
  async deleteUser(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.authService.deleteUser(id, user.id);
  }
}
