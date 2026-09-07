import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One facility request from the requisitioner — HR's confirm/skip decision is added server-side. */
export class FacilityRequestDto {
  @IsBoolean()
  requested!: boolean;

  /** 'laptop'|'desktop' for laptopDesktop; 'existing'|'new' for seating; unused otherwise. */
  @IsOptional()
  @IsIn(['laptop', 'desktop', 'existing', 'new'])
  option?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class FacilitiesRequestDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => FacilityRequestDto)
  laptopDesktop!: FacilityRequestDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => FacilityRequestDto)
  transport!: FacilityRequestDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => FacilityRequestDto)
  dormitory!: FacilityRequestDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => FacilityRequestDto)
  seating!: FacilityRequestDto;
}

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

  /** DBL business vertical — one of master_options kind='line_of_business'. */
  @IsString()
  @IsNotEmpty()
  lineOfBusiness!: string;

  @IsString()
  @IsNotEmpty()
  department!: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  subSection?: string;

  /**
   * The requisitioner's own declaration: a brand-new headcount, or a
   * replacement for someone who left. Previously derived from the organogram —
   * the seat lookup is now advisory, so the two can legitimately disagree.
   */
  @IsIn(['new', 'existing'])
  requirementType!: 'new' | 'existing';

  /** Replacement details — required when requirementType is 'existing'. */
  @IsOptional()
  @IsString()
  replaceOfName?: string;

  @IsOptional()
  @IsString()
  replaceOfEmployeeCode?: string;

  @IsOptional()
  @IsString()
  separationReason?: string;

  @IsOptional()
  @IsString()
  replacementRemarks?: string;

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

  @IsDefined()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FacilitiesRequestDto)
  facilities!: FacilitiesRequestDto;

  @IsOptional()
  @IsArray()
  @IsIn(['job_advertisement', 'headhunting', 'cv_bank'], {
    each: true,
  })
  preferredSources?: string[];

  @ValidateNested()
  @Type(() => SignatoriesDto)
  signatories!: SignatoriesDto;
}
