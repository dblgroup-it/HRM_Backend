import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
}

export class SubmitVoteDto {
  @IsString() @IsOptional() @MaxLength(1000) notes?: string;
}

export class HrApproveDto {
  @IsString() @IsOptional() @MaxLength(500) note?: string;
}
