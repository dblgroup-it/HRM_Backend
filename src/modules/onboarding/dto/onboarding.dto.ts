import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { OnboardingDocStatus, MedicalStatus } from '@prisma/client';

export class UploadDocDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;
}

export class VerifyDocDto {
  @IsIn(['verified', 'rejected', 'pending'])
  status!: OnboardingDocStatus;
}

export class MedicalDto {
  @IsIn(['cleared', 'rejected', 'pending'])
  status!: MedicalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class NotifyItDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  assetId?: string;
}
