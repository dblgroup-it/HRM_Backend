import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class SignatoriesDto {
  @IsString()
  @MinLength(2)
  departmentHeadName!: string;

  @IsOptional()
  @IsString()
  departmentHeadDesignation?: string;

  @IsOptional()
  @IsString()
  factoryHRName?: string;
}

export class CreateRequisitionDto {
  @IsString()
  @MinLength(2)
  designation!: string;

  @IsIn(['factory', 'ho'])
  source!: 'factory' | 'ho';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredPosts!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  totalVacantPosts!: number;

  @IsString()
  @IsNotEmpty()
  unitFactory!: string;

  @IsString()
  @IsNotEmpty()
  department!: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsString()
  @IsNotEmpty()
  placeOfPosting!: string;

  @IsOptional()
  @IsString()
  vacantDate?: string;

  @IsOptional()
  @IsString()
  neededDate?: string;

  @IsIn(['top', 'moderate', 'ordinary'])
  priority!: 'top' | 'moderate' | 'ordinary';

  @IsIn(['permanent', 'temporary', 'contractual'])
  employmentNature!: 'permanent' | 'temporary' | 'contractual';

  @IsOptional()
  @IsString()
  contractualPurpose?: string;

  @IsString()
  @MinLength(5)
  jobDescription!: string;

  @IsString()
  @IsNotEmpty()
  education!: string;

  @IsString()
  @IsNotEmpty()
  experience!: string;

  @IsOptional()
  @IsString()
  others?: string;

  @IsIn(['not_applicable', 'desktop', 'laptop'])
  computer!: 'not_applicable' | 'desktop' | 'laptop';

  @IsOptional()
  @IsString()
  computerReason?: string;

  @IsIn(['existing', 'new'])
  seating!: 'existing' | 'new';

  @IsOptional()
  @IsArray()
  @IsIn(['job_advertisement', 'headhunting', 'referral', 'cv_bank'], {
    each: true,
  })
  preferredSources?: string[];

  @ValidateNested()
  @Type(() => SignatoriesDto)
  signatories!: SignatoriesDto;
}
