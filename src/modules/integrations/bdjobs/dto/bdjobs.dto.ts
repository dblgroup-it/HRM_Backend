import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class PostBdJobsDto {
  @IsString() @IsNotEmpty() jobTitle!: string;
  @IsInt() @Min(1) vacancyNo!: number;
  @IsArray() locationIds!: number[];
  @IsArray() locationNames!: string[];
  @IsOptional() @IsInt() categoryId!: number | null;
  @IsString() categoryName!: string;
  @IsArray() employmentStatus!: string[];
  @IsArray() workplace!: string[];
  @IsNumber() @Min(0) salaryMin!: number;
  @IsNumber() @Min(0) salaryMax!: number;
  @IsBoolean() showSalary!: boolean;
  @IsString() @IsNotEmpty() jobDescription!: string;
  @IsString() preferredGender!: string;
  @IsOptional() @IsInt() ageMin!: number | null;
  @IsOptional() @IsInt() ageMax!: number | null;
  @IsInt() @Min(0) experienceYears!: number;
  @IsString() educationLevel!: string;
  @IsArray() industryExperience!: string[];
  @IsArray() skills!: string[];
  @IsString() additionalRequirements!: string;
  @IsBoolean() restrictAge!: boolean;
  @IsBoolean() restrictGender!: boolean;
  @IsBoolean() restrictExperience!: boolean;
  @IsBoolean() applyOnline!: boolean;
  @IsBoolean() publishLinkedIn!: boolean;
}
