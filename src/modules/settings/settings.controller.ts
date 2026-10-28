import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ConfigService } from '@nestjs/config';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import type { AiProviderName } from '../integrations/ai/ai-provider';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { AiProviderConfigService } from '../integrations/ai/ai-provider-config.service';
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

class UpdateAiProviderDto {
  @IsOptional()
  @IsIn(['claude', 'gemini'])
  provider?: AiProviderName;

  @IsOptional()
  @IsBoolean()
  fallback?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  claudeModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  geminiModel?: string;

  /** A new key; an empty string removes the saved one. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  claudeKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  geminiKey?: string;
}

class TestAiProviderDto {
  @IsIn(['claude', 'gemini'])
  provider!: AiProviderName;

  /** Test a key typed on the page before saving it; else the saved one. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;
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
  computerTestPassPct?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  aiTestPassPct?: number;
}

class UpdateItRequestSettingsDto {
  /** As typed: one or more addresses separated by commas. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  recipients?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  salutation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;
}

class UpdateTutorialVideoSettingsDto {
  /** As pasted: a playlist link, a video link with `list=`, or the id. Empty takes it off the page. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  playlist?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  channel?: string;
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService,
    private readonly aiProvider: AiProviderConfigService,
    private readonly aiGrader: AiGraderService,
  ) {}

  /** Anyone authenticated can read AI config (used to label the UI). */
  @Get('ai')
  getAi() {
    return this.settings.getAiConfigView();
  }

  /** Super users, and Head of Talent Acquisition / CHRO (both global roles), may change it. */
  @Patch('ai')
  async updateAi(
    @Body() dto: UpdateAiSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireAiSettingsAccess(user.id);
    return this.settings.setAiConfig(dto);
  }

  /**
   * Which AI provider answers first, each one's model and key, and whether the
   * other takes over on a failure (super user only — Integrations). Keys are
   * never returned: only whether one is set, where from, and its last four.
   */
  @Get('ai-provider')
  async getAiProvider(@CurrentUser() user: AuthUser) {
    await this.requireSuperUser(user.id, 'view the AI provider settings');
    return this.aiProvider.view();
  }

  @Patch('ai-provider')
  async updateAiProvider(
    @Body() dto: UpdateAiProviderDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireSuperUser(user.id, 'change the AI provider settings');
    return this.aiProvider.update(dto);
  }

  /** One tiny request to one provider — is this key and model working? */
  @Post('ai-provider/test')
  @HttpCode(200)
  async testAiProvider(
    @Body() dto: TestAiProviderDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireSuperUser(user.id, 'test the AI provider');
    return this.aiGrader.testProvider(dto.provider, {
      apiKey: dto.apiKey,
      model: dto.model,
    });
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

  /** Where "Notify IT" sends requests and how they open (super user only). */
  @Get('it-requests')
  async getItRequests(@CurrentUser() user: AuthUser) {
    await this.requireSuperUser(user.id, 'view the IT request settings');
    return this.settings.getItRequestConfig();
  }

  @Patch('it-requests')
  async updateItRequests(
    @Body() dto: UpdateItRequestSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireSuperUser(user.id, 'change the IT request settings');
    return this.settings.setItRequestConfig(dto);
  }

  /** The video playlist on the Tutorials page (super user only; everyone sees it there). */
  @Get('tutorial-videos')
  async getTutorialVideos(@CurrentUser() user: AuthUser) {
    await this.requireSuperUser(user.id, 'view the video tutorial settings');
    return this.settings.getTutorialVideoConfig();
  }

  @Patch('tutorial-videos')
  async updateTutorialVideos(
    @Body() dto: UpdateTutorialVideoSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireSuperUser(user.id, 'change the video tutorial settings');
    return this.settings.setTutorialVideoConfig(dto);
  }

  /** Anyone authenticated can read the pass marks (shown in Salary Fixation). */
  @Get('screening')
  getScreening() {
    return this.settings.getScreeningConfig();
  }

  /** Super users, and Head of Talent Acquisition / CHRO, may change the pass marks — this
   * card lives on the same "AI Settings" page as /settings/ai. */
  @Patch('screening')
  async updateScreening(
    @Body() dto: UpdateScreeningSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.requireAiSettingsAccess(user.id);
    return this.settings.setScreeningConfig(dto);
  }

  private async requireSuperUser(userId: string, what: string): Promise<void> {
    if (!(await this.permissions.isSuperUser(userId))) {
      throw new ForbiddenException(`Only a super user can ${what}`);
    }
  }

  /** Head of Talent Acquisition and CHRO are both GLOBAL roles, so no unit to scope
   * against — a plain role-key check is enough, no hasRoleForUnitName needed. */
  private async requireAiSettingsAccess(userId: string): Promise<void> {
    if (await this.permissions.isSuperUser(userId)) return;
    const perms = await this.permissions.getUserPermissions(userId);
    const allowed = perms.roles.some(
      (r) => r.key === 'corporate_hr' || r.key === 'chro',
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only Head of Talent Acquisition, CHRO or a super user can change AI settings',
      );
    }
  }
}
