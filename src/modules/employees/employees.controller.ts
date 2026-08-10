import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';

import { EmployeesService } from './employees.service';
import { QueryEmployeesDto } from './dto/query-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

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

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employeesService.update(id, dto);
  }
}
