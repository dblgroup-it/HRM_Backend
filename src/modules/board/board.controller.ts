import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { BoardService } from './board.service';
import {
  AddMembersDto,
  CreateBoardGroupDto,
  HrApproveDto,
  SendBoardApprovalDto,
  UpdateBoardGroupDto,
} from './dto/board.dto';

@Controller()
export class BoardController {
  constructor(private readonly board: BoardService) {}

  /* ── Board Groups ── */

  @Get('board-groups')
  listGroups() {
    return this.board.listGroups();
  }

  @Post('board-groups')
  createGroup(@Body() dto: CreateBoardGroupDto) {
    return this.board.createGroup(dto.name, dto.description);
  }

  @Patch('board-groups/:id')
  updateGroup(@Param('id') id: string, @Body() dto: UpdateBoardGroupDto) {
    return this.board.updateGroup(id, dto.name, dto.description);
  }

  @Delete('board-groups/:id')
  deleteGroup(@Param('id') id: string) {
    return this.board.deleteGroup(id);
  }

  @Post('board-groups/:id/members')
  addMembers(@Param('id') id: string, @Body() dto: AddMembersDto) {
    return this.board.addMembers(id, dto.userIds);
  }

  @Delete('board-groups/:id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.board.removeMember(id, userId);
  }

  /* ── Board Approval on a candidate ── */

  @Post('candidates/:id/board-approval')
  sendForApproval(
    @Param('id') candidateId: string,
    @Body() dto: SendBoardApprovalDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.board.sendForApproval(candidateId, dto.memberIds, user.id);
  }

  @Get('candidates/:id/board-approval')
  getApprovalStatus(@Param('id') candidateId: string) {
    return this.board.getApprovalStatus(candidateId);
  }

  @Post('candidates/:id/board-approval/hr-approve')
  hrApprove(
    @Param('id') candidateId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: HrApproveDto,
  ) {
    return this.board.hrApprove(candidateId, user.id, dto.note);
  }
}
