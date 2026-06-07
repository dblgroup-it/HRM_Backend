import { Controller, Get, Param, Query } from '@nestjs/common';

import { EmployeesService } from './employees.service';
import { QueryEmployeesDto } from './dto/query-employees.dto';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  findAll(@Query() query: QueryEmployeesDto) {
    return this.employeesService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.employeesService.findOne(id);
  }
}
