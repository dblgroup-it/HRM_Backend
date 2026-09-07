import {
  IsIn, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
  /** Required when the chain will start at Corporate HR. */
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
