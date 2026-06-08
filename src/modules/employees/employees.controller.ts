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

  /** Dept → Section → Designation tree for the requisition form dropdowns. */
  @Get('structure')
  structure(@Query('unit') unit?: string) {
    return this.employeesService.getStructure(unit);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.employeesService.findOne(id);
  }
}
