import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** Mirrors the modal's BdJobsFormData exactly (strict ValidationPipe). */
export class PostBdJobsDto {
  @IsString() @IsNotEmpty() jobTitle!: string;
  @IsInt() @Min(1) vacancyNo!: number;
  @IsArray() locationIds!: number[];
  @IsArray() locationNames!: string[];
  @IsOptional() @IsInt() categoryId!: number | null;
  @IsString() categoryName!: string;
  @IsArray() employmentStatus!: string[];
  @IsArray() workplace!: string[];
  @IsOptional() @IsNumber() salaryMin!: number | null;
  @IsOptional() @IsNumber() salaryMax!: number | null;
  @IsBoolean() showSalary!: boolean;
  @IsString() @IsNotEmpty() jobDescription!: string;
  @IsString() preferredGender!: string;
  @IsOptional() @IsInt() ageMin!: number | null;
  @IsOptional() @IsInt() ageMax!: number | null;
  @IsOptional() @IsNumber() experienceYears!: number | null;
  @IsOptional() @IsInt() educationLevelId!: number | null;
  @IsString() educationLevelName!: string;
  @IsOptional() @IsInt() educationDegreeId!: number | null;
  @IsString() educationDegreeName!: string;
  @IsString() educationConcentration!: string;
  @IsArray() industryExperience!: { id: string; name: string }[];
  @IsArray() skills!: { id: number; name: string }[];
  @IsString() additionalRequirements!: string;
  @IsBoolean() restrictAge!: boolean;
  @IsBoolean() restrictGender!: boolean;
  @IsBoolean() restrictExperience!: boolean;
  @IsBoolean() applyOnline!: boolean;
  @IsBoolean() publishLinkedIn!: boolean;
}
