import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { UnitsService } from './units.service';
import {
  CreateDepartmentDto,
  CreateUnitDto,
  UpdateDepartmentDto,
  UpdateUnitDto,
  UpdatePositionDto,
  UpsertPositionDto,
} from './dto/unit.dto';

@Controller('units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  findAll() {
    return this.unitsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.unitsService.findOne(id);
  }

  // Write access below is enforced in UnitsService (dynamic RBAC — Corporate
  // HR / CHRO / Factory HR / SBU Head for the unit in question, per unit
  // config access rules), not by a static @Roles() gate here. Creating a
  // brand-new unit is the one exception still requiring a global role.
  @Post()
  create(@Body() dto: CreateUnitDto, @CurrentUser() user: AuthUser) {
    return this.unitsService.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUnitDto, @CurrentUser() user: AuthUser) {
    return this.unitsService.update(id, dto, user.id);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.unitsService.remove(id);
  }

  @Post(':id/departments')
  addDepartment(@Param('id') id: string, @Body() dto: CreateDepartmentDto, @CurrentUser() user: AuthUser) {
    return this.unitsService.addDepartment(id, dto, user.id);
  }

  @Patch('departments/:departmentId')
  updateDepartment(
    @Param('departmentId') departmentId: string,
    @Body() dto: UpdateDepartmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unitsService.updateDepartment(departmentId, dto.name, user.id);
  }

  @Delete('departments/:departmentId')
  removeDepartment(@Param('departmentId') departmentId: string, @CurrentUser() user: AuthUser) {
    return this.unitsService.removeDepartment(departmentId, user.id);
  }

  @Post('departments/:departmentId/positions')
  upsertPosition(
    @Param('departmentId') departmentId: string,
    @Body() dto: UpsertPositionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unitsService.upsertPosition(departmentId, dto, user.id);
  }

  @Patch('positions/:positionId')
  updatePosition(
    @Param('positionId') positionId: string,
    @Body() dto: UpdatePositionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unitsService.updatePosition(positionId, dto, user.id);
  }

  @Delete('positions/:positionId')
  removePosition(@Param('positionId') positionId: string, @CurrentUser() user: AuthUser) {
    return this.unitsService.removePosition(positionId, user.id);
  }
}
