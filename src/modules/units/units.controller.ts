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

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Post()
  create(@Body() dto: CreateUnitDto, @CurrentUser() user: AuthUser) {
    return this.unitsService.create(dto, user.id);
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUnitDto, @CurrentUser() user: AuthUser) {
    return this.unitsService.update(id, dto, user.id);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.unitsService.remove(id);
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Post(':id/departments')
  addDepartment(@Param('id') id: string, @Body() dto: CreateDepartmentDto, @CurrentUser() user: AuthUser) {
    return this.unitsService.addDepartment(id, dto, user.id);
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Patch('departments/:departmentId')
  updateDepartment(
    @Param('departmentId') departmentId: string,
    @Body() dto: UpdateDepartmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unitsService.updateDepartment(departmentId, dto.name, user.id);
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Delete('departments/:departmentId')
  removeDepartment(@Param('departmentId') departmentId: string) {
    return this.unitsService.removeDepartment(departmentId);
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Post('departments/:departmentId/positions')
  upsertPosition(
    @Param('departmentId') departmentId: string,
    @Body() dto: UpsertPositionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unitsService.upsertPosition(departmentId, dto, user.id);
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Patch('positions/:positionId')
  updatePosition(
    @Param('positionId') positionId: string,
    @Body() dto: UpdatePositionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unitsService.updatePosition(positionId, dto, user.id);
  }

  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Delete('positions/:positionId')
  removePosition(@Param('positionId') positionId: string) {
    return this.unitsService.removePosition(positionId);
  }
}
