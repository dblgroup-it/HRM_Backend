import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ConfigService } from '@nestjs/config';

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

class UpdateNotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;
}

class UpdateScreeningSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  writtenTestPassPct?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  aiTestPassPct?: number;
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService,
  ) {}

  /** Anyone authenticated can read AI config (used to label the UI). */
  @Get('ai')
  getAi() {
    return this.settings.getAiConfigView();
  }

  /** Super users, and Corporate HR / CHRO (both global roles), may change it. */
  @Patch('ai')
  async updateAi(
    @Body() dto: UpdateAiSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireAiSettingsAccess(user.id);
    return this.settings.setAiConfig(dto);
  }

  /** Read notification config + mail SMTP status (super user only). */
  @Get('notifications')
  async getNotifications(@CurrentUser() user: AuthUser) {
    if (!(await this.permissions.isSuperUser(user.id))) {
      throw new ForbiddenException(
        'Only a super user can view notification settings',
      );
    }
    const config = await this.settings.getNotificationConfig();
    return {
      ...config,
      mailConfigured: Boolean(
        this.config.get('mail.user') && this.config.get('mail.appPassword'),
      ),
    };
  }

  /** Toggle the system-wide email master switch (super user only). */
  @Patch('notifications')
  async updateNotifications(
    @Body() dto: UpdateNotificationSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!(await this.permissions.isSuperUser(user.id))) {
      throw new ForbiddenException(
        'Only a super user can change notification settings',
      );
    }
    return this.settings.setNotificationConfig(dto);
  }

  /** Anyone authenticated can read the pass marks (shown in Salary Fixation). */
  @Get('screening')
  getScreening() {
    return this.settings.getScreeningConfig();
  }

  /** Super users, and Corporate HR / CHRO, may change the pass marks — this
   * card lives on the same "AI Settings" page as /settings/ai. */
  @Patch('screening')
  async updateScreening(
    @Body() dto: UpdateScreeningSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireAiSettingsAccess(user.id);
    return this.settings.setScreeningConfig(dto);
  }

  /** Corporate HR and CHRO are both GLOBAL roles, so no unit to scope
   * against — a plain role-key check is enough, no hasRoleForUnitName needed. */
  private async requireAiSettingsAccess(userId: string): Promise<void> {
    if (await this.permissions.isSuperUser(userId)) return;
    const perms = await this.permissions.getUserPermissions(userId);
    const allowed = perms.roles.some(
      (r) => r.key === 'corporate_hr' || r.key === 'chro',
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can change AI settings',
      );
    }
  }
}
