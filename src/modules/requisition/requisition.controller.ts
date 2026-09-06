import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Patch,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';

import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { ATTACHMENT_UPLOAD } from '../../common/upload/file-upload';
import { RequisitionService } from './requisition.service';
import { CreateRequisitionDto } from './dto/create-requisition.dto';
import {
  ApprovalActionDto,
  AssignRecruiterDto,
  DraftRequisitionDto,
  PostRequisitionDto,
  QueryRequisitionsDto,
  UpdateFacilitiesDto,
  UpdateRequisitionDto,
  UpdateRoleProfileDto,
} from './dto/requisition-actions.dto';

@Controller('requisitions')
export class RequisitionController {
  constructor(private readonly requisitionService: RequisitionService) {}

  @Get()
  findAll(@Query() query: QueryRequisitionsDto, @CurrentUser() user: AuthUser) {
    return this.requisitionService.findAll(query, user.id);
  }

  /** Status counts for the list page's tiles/chips (static route before :id). */
  @Get('stats')
  stats(@Query() query: QueryRequisitionsDto, @CurrentUser() user: AuthUser) {
    return this.requisitionService.stats(query, user.id);
  }

  /**
   * AI quick-fill: describe the vacancy in plain language and get a drafted
   * form back. Nothing is saved — the requester reviews and edits before
   * submitting.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('draft')
  draft(@Body() dto: DraftRequisitionDto, @CurrentUser() user: AuthUser) {
    return this.requisitionService.draft(dto.prompt, user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.requisitionService.findOne(id, user.id);
  }

  @Post()
  create(@Body() dto: CreateRequisitionDto, @CurrentUser() user: AuthUser) {
    return this.requisitionService.create(dto, {
      id: user.id,
      name: user.name,
    });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRequisitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requisitionService.update(id, dto, {
      id: user.id,
      name: user.name,
    });
  }

  /** HR (whoever's turn it currently is) confirms or skips facility requests. */
  @Patch(':id/facilities')
  updateFacilities(
    @Param('id') id: string,
    @Body() dto: UpdateFacilitiesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requisitionService.updateFacilities(id, dto, {
      id: user.id,
      name: user.name,
    });
  }

  @Patch(':id/approval')
  act(
    @Param('id') id: string,
    @Body() dto: ApprovalActionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requisitionService.act(id, dto, {
      id: user.id,
      name: user.name,
    });
  }

  @Get(':id/recruiters')
  listRecruiters(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.requisitionService.listRecruiters(id, user.id);
  }

  @Patch(':id/recruiter')
  assignRecruiter(
    @Param('id') id: string,
    @Body() dto: AssignRecruiterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requisitionService.assignRecruiter(id, dto.recruiterId, {
      id: user.id,
      name: user.name,
    });
  }

  // Corporate HR (or a super user) continues from here — enforced in the service.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/role-profile')
  generateRoleProfile(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.requisitionService.generateRoleProfile(id, {
      id: user.id,
      name: user.name,
    });
  }

  /** Save manual edits to the role profile (Corporate HR / super). */
  @Patch(':id/role-profile')
  updateRoleProfile(
    @Param('id') id: string,
    @Body() dto: UpdateRoleProfileDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requisitionService.updateRoleProfile(id, dto, {
      id: user.id,
      name: user.name,
    });
  }

  @Post(':id/post')
  post(
    @Param('id') id: string,
    @Body() dto: PostRequisitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requisitionService.post(id, dto, {
      id: user.id,
      name: user.name,
    });
  }

  /** Attach a supporting file (optional). 15 MB cap; stored on Drive. */
  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file', ATTACHMENT_UPLOAD))
  addAttachment(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile()
    file?: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
      size: number;
    },
  ) {
    return this.requisitionService.addAttachment(id, file, {
      id: user.id,
      name: user.name,
    });
  }

  @Delete(':id/attachments/:fileId')
  removeAttachment(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requisitionService.removeAttachment(id, fileId, {
      id: user.id,
      name: user.name,
    });
  }
}
