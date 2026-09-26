import { Controller, Post, Get, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Role } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
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
