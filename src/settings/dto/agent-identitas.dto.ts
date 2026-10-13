import { IsString, IsNotEmpty } from 'class-validator';

/// Identitas PC untuk endpoint yang dipakai agent (tanpa JWT operator).
export class AgentIdentitasDto {
  @IsString()
  @IsNotEmpty()
  pcId: string;

  @IsString()
  @IsNotEmpty()
  agentToken: string;
}
