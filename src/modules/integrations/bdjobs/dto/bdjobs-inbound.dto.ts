import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class InboundCandidateDto {
  @IsString() @MaxLength(150) name!: string;
  @IsString() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}

class InboundProfileDto {
  @IsString() @MaxLength(100) bdjobsApplicantId!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) skills?: string[];
}

class InboundResumeDto {
  @IsString() url!: string;
  @IsOptional() @IsString() @MaxLength(255) fileName?: string;
  @IsOptional() @IsString() @MaxLength(100) mimeType?: string;
}

export class BdJobsInboundCandidateDto {
  @IsOptional() @IsString() @MaxLength(100) jobReferenceId?: string;
  @IsString() @MaxLength(100) bdJobsJobId!: string;
  @IsString() @MaxLength(100) applicationId!: string;

  @IsObject() @ValidateNested() @Type(() => InboundCandidateDto)
  candidate!: InboundCandidateDto;

  @IsObject() @ValidateNested() @Type(() => InboundProfileDto)
  profile!: InboundProfileDto;

  @IsObject() @ValidateNested() @Type(() => InboundResumeDto)
  resume!: InboundResumeDto;

  @IsInt() ts!: number;
}
