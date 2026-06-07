import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Query,
} from '@nestjs/common';

import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequisitionService } from './requisition.service';
import { CreateRequisitionDto } from './dto/create-requisition.dto';
import {
  ApprovalActionDto,
  PostRequisitionDto,
  QueryRequisitionsDto,
  UpdateRequisitionDto,
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
    return this.requisitionService.act(id, dto, { id: user.id, name: user.name });
  }

  // Corporate HR (or a super user) continues from here — enforced in the service.
  @Post(':id/role-profile')
  generateRoleProfile(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.requisitionService.generateRoleProfile(id, {
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
    return this.requisitionService.post(id, dto, { id: user.id, name: user.name });
  }
}
