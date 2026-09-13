import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { DOC_UPLOAD } from '../../common/upload/file-upload';
import { BoardService, type UploadedAttachment } from './board.service';
import {
  AddMembersDto,
  CreateBoardGroupDto,
  HrApproveDto,
  SendBoardApprovalDto,
  UpdateBoardGroupDto,
  SendSheetDto,
  UpdateSheetRowDto,
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
    return this.board.sendForApproval(
      candidateId,
      dto.memberIds,
      user.id,
      dto.corporateHrId,
      dto.chroId,
    );
  }

  /** Who the first link of the chain can be sent to. */
  @Get('candidates/:id/board-approval/approvers')
  listChainApprovers(
    @Param('id') candidateId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.board.listChainApprovers(candidateId, user.id);
  }

  @Get('candidates/:id/board-approval')
  getApprovalStatus(@Param('id') candidateId: string) {
    return this.board.getApprovalStatus(candidateId);
  }

  /** Everything waiting on this Head of Talent Acquisition, ready to be put onto a sheet. */
  @Get('board-approvals/inbox')
  hrInbox(@CurrentUser() user: AuthUser) {
    return this.board.hrInbox(user.id);
  }

  /** Sheets this user has sent, with where each one has got to. */
  @Get('board-sheets')
  listSheets(@CurrentUser() user: AuthUser) {
    return this.board.listSheets(user.id);
  }

  /** Send the sheet's current stage out again, to whoever still owes a reply. */
  @Post('board-sheets/:id/resend')
  resendSheet(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.board.resendSheet(id, user.id);
  }

  /** Correct a row's CV-derived columns before the sheet is sent. */
  @Patch('board-approvals/:id/sheet-row')
  updateSheetRow(
    @Param('id') id: string,
    @Body() dto: UpdateSheetRowDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.board.updateSheetRow(id, user.id, dto);
  }

  /** Who can sign a sheet: CHRO holders and the configured board groups. */
  @Get('board-sheets/approvers')
  sheetApprovers(@CurrentUser() user: AuthUser) {
    return this.board.sheetApprovers(user.id);
  }

  /** Send one or many candidates onward as a single sheet. */
  @Post('board-sheets')
  sendSheet(@Body() dto: SendSheetDto, @CurrentUser() user: AuthUser) {
    return this.board.sendSheet(
      dto.approvalIds,
      dto.chroId,
      dto.boardMemberIds,
      user.id,
    );
  }

  @Post('candidates/:id/board-approval/hr-approve')
  @UseInterceptors(FileInterceptor('file', DOC_UPLOAD))
  hrApprove(
    @Param('id') candidateId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: HrApproveDto,
    @UploadedFile() file?: UploadedAttachment,
  ) {
    return this.board.hrApprove(candidateId, user.id, dto.note, file);
  }
}
