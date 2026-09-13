import {
  ArrayMinSize,
  IsIn,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateBoardGroupDto {
  @IsString() @IsNotEmpty() @MaxLength(150) name!: string;
  @IsString() @IsOptional() @MaxLength(500) description?: string;
}

export class UpdateBoardGroupDto {
  @IsString() @IsOptional() @MaxLength(150) name?: string;
  @IsString() @IsOptional() @MaxLength(500) description?: string;
}

export class AddMembersDto {
  @IsArray() @IsString({ each: true }) userIds!: string[];
}

export class SendBoardApprovalDto {
  @IsArray() @IsString({ each: true }) memberIds!: string[];
  /** Required when the chain will start at Head of Talent Acquisition. */
  @IsOptional() @IsString() corporateHrId?: string;
  /** Required whenever the chain will pass through the CHRO. */
  @IsOptional() @IsString() chroId?: string;
}

export class SubmitVoteDto {
  /** Omitted means approve — keeps existing links working. */
  @IsOptional()
  @IsIn(['approved', 'rejected'])
  decision?: 'approved' | 'rejected';

  @IsString() @IsOptional() @MaxLength(1000) notes?: string;
}

export class HrApproveDto {
  @IsString() @IsOptional() @MaxLength(500) note?: string;
}

/** Put candidates onto one Hiring Approval Sheet and send it to the CHRO. */
export class SendSheetDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  approvalIds!: string[];

  @IsString()
  @IsNotEmpty()
  chroId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  boardMemberIds!: string[];
}

/** The CV-derived sheet columns, as corrected by Head of Talent Acquisition. */
export class UpdateSheetRowDto {
  @IsOptional() @IsString() @MaxLength(400) education?: string | null;
  @IsOptional() @IsString() @MaxLength(60) totalExperience?: string | null;
  @IsOptional() @IsString() @MaxLength(200) lastOrganization?: string | null;
}
