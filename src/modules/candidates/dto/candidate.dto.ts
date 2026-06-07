import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const STAGES = [
  'applied',
  'shortlisted',
  'interview',
  'final',
  'selected',
  'rejected',
] as const;

const SOURCES = ['manual', 'upload', 'email', 'drive'] as const;

export class CreateCandidateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsIn(SOURCES)
  source?: string;
}

export class UpdateCandidateDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsIn(STAGES)
  stage?: string;
}
