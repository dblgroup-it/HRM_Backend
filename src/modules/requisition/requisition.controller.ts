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
  PostRequisitionDto,
  QueryRequisitionsDto,
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
