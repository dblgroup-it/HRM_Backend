import { IsString, MaxLength, MinLength } from 'class-validator';

export class AskDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  question!: string;
}
