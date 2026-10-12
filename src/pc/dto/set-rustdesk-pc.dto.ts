import { IsString, IsOptional, IsUUID } from 'class-validator';

export class SetRustdeskPcDto {
  @IsUUID()
  pcId: string;

  @IsString()
  rustdeskPassword: string;

  @IsUUID()
  agentToken: string;
}