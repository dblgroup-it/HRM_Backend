import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateEmployeeDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @IsIn(['Male', 'Female', 'Other']) gender?: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
}
