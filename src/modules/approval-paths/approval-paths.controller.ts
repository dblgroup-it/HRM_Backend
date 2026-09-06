import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';

import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { ApprovalPathsService } from './approval-paths.service';
import {
  AddRaiserDto,
  ReplaceApprovalPathDto,
} from './dto/approval-path.dto';

// Access is enforced in ApprovalPathsService (dynamic RBAC — Corporate HR,
// CHRO or a super user), not by a static @Roles() gate here.
@Controller('approval-paths')
export class ApprovalPathsController {
  constructor(private readonly approvalPaths: ApprovalPathsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.approvalPaths.findAll(user.id);
  }

  /** Nominate a Requisition Raiser for a unit (creates their empty chain). */
  @Post(':unitId/raisers')
  addRaiser(
    @Param('unitId') unitId: string,
    @Body() dto: AddRaiserDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvalPaths.addRaiser(unitId, dto.raiserId, user.id);
  }

  @Get(':unitId/raisers/:raiserId')
  findOne(
    @Param('unitId') unitId: string,
    @Param('raiserId') raiserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvalPaths.findOne(unitId, raiserId, user.id);
  }

  /** Replace one raiser's intermediate approvers. */
  @Put(':unitId/raisers/:raiserId')
  replace(
    @Param('unitId') unitId: string,
    @Param('raiserId') raiserId: string,
    @Body() dto: ReplaceApprovalPathDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvalPaths.replace(unitId, raiserId, dto, user.id);
  }

  @Delete(':unitId/raisers/:raiserId')
  removeRaiser(
    @Param('unitId') unitId: string,
    @Param('raiserId') raiserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvalPaths.removeRaiser(unitId, raiserId, user.id);
  }
}
