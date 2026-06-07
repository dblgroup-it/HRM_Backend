import { IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryEmployeesDto extends PaginationDto {
  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  unit?: string;
}
