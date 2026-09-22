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
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One facility request from the requisitioner — HR's confirm/skip decision is added server-side. */
export class FacilityRequestDto {
  @IsBoolean()
  requested!: boolean;

  /**
   * 'laptop'|'desktop' for laptopDesktop; 'existing'|'new' for seating;
   * 'shared'|'full_time' for transport; unused otherwise.
   */
  @IsOptional()
  @IsIn(['laptop', 'desktop', 'existing', 'new', 'shared', 'full_time'])
  option?: string;

  /** Transport, full-time car only — a shared run is whatever is on it. */
  @IsOptional()
  @IsIn(['sedan', 'suv'])
  vehicleType?: string;

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

/**
 * One person this requisition replaces.
 *
 * A requisition can refill several seats at once — three leavers, one
 * requisition — and each carries their own reason and vacancy date, because
 * people rarely leave on the same day for the same reason.
 */
export class ReplacedEmployeeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  employeeName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  employeeCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  separationReason?: string;

  /** ISO date — when their seat actually became free. */
  @IsOptional()
  @IsString()
  vacantDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

/**
 * What the requisitioner fills in: section A (Vacancy Information) and the
 * facility requirements, nothing else.
 *
 * Section B (Job Analysis) and the attachments are completed afterwards by the
 * unit's Factory HR — see `JobAnalysisDto` — and only then does the approval
 * chain start. Preferred sources are gone entirely: every posted requisition
 * goes to the career page.
 */
export class CreateRequisitionDto {
  @IsString()
  @MinLength(2)
  designation!: string;

  /**
   * Other levels this post may be filled at, e.g. "Senior Executive" raised
   * alongside "Assistant Manager" when the level depends on who is found.
   *
   * `designation` remains the primary — the organogram lookup and approval
   * routing read it — and an empty list is an ordinary single-designation
   * requisition. Which level a candidate is actually hired at is settled per
   * person during onboarding.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(150, { each: true })
  alternateDesignations?: string[];

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

  /**
   * Everyone this requisition replaces. Preferred over the four single fields
   * below, which are kept because existing clients still send them and several
   * reports still read the columns they map to. When this list is sent, the
   * first entry is mirrored into those columns so nothing downstream changes.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReplacedEmployeeDto)
  replacements?: ReplacedEmployeeDto[];

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

  @IsDefined()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => FacilitiesRequestDto)
  facilities!: FacilitiesRequestDto;

  @ValidateNested()
  @Type(() => SignatoriesDto)
  signatories!: SignatoriesDto;
}
