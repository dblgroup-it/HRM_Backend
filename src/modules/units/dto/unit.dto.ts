import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { SeatCategory } from '@prisma/client';

export class CreateUnitDto {
  @IsString()
  @MinLength(2)
  name!: string;
}

export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateDepartmentDto {
  @IsString()
  @MinLength(2)
  name!: string;
}

export class UpdateDepartmentDto {
  @IsString()
  @MinLength(2)
  name!: string;
}

export class UpsertPositionDto {
  @IsString()
  @MinLength(2)
  designation!: string;

  @IsOptional()
  @IsEnum(SeatCategory)
  category?: SeatCategory;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  sanctioned!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  filled?: number;
}

export class UpdatePositionDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  designation?: string;

  @IsOptional()
  @IsEnum(SeatCategory)
  category?: SeatCategory;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sanctioned?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  filled?: number;
}
