import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class AddCommitteeMemberDto {
  @IsString()
  @MinLength(1)
  memberUserId!: string;

  @IsOptional()
  @IsIn(['interviewer', 'evaluator'])
  role?: string;
}

export class SaveNotesDto {
  @IsString()
  notes!: string;
}
