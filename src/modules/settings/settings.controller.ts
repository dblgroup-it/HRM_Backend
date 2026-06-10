import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PermissionsService } from '../rbac/permissions.service';
import { SettingsService } from './settings.service';

class UpdateAiSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  shortlistThreshold?: number;

  @IsOptional()
  @IsBoolean()
  autoScreen?: boolean;

  @IsOptional()
  @IsBoolean()
  autoRoleProfile?: boolean;
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Anyone authenticated can read AI config (used to label the UI). */
  @Get('ai')
  getAi() {
    return this.settings.getAiConfigView();
  }

  /** Only super users may change it. */
  @Patch('ai')
  async updateAi(
    @Body() dto: UpdateAiSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!(await this.permissions.isSuperUser(user.id))) {
      throw new ForbiddenException('Only a super user can change AI settings');
    }
    return this.settings.setAiConfig(dto);
  }
}
