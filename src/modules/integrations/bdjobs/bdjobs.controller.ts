import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { Response } from 'express';

import { Roles } from '../../../common/decorators/roles.decorator';
import { BdJobsSettingsService } from './bdjobs-settings.service';

import {
  AuthUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { BdJobsService } from './bdjobs.service';
import { PostBdJobsDto } from './dto/bdjobs.dto';
import { BdJobsInboundCandidateDto } from './dto/bdjobs-inbound.dto';
import type { PostBdJobsFormData } from './bdjobs.types';

/** Admin-editable BDJobs configuration (blank secrets = keep current). */
class UpdateBdJobsSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() baseUrl?: string;
  @IsOptional() @IsString() companyId?: string;
  @IsOptional() @IsString() authToken?: string;
  @IsOptional() @IsString() decodeId?: string;
  @IsOptional() @IsString() signatureFormat?: string;
  @IsOptional() @IsString() specialInstruction?: string;
  @IsOptional() @IsString() otherBenefits?: string;
  @IsOptional() @IsInt() @Min(1) @Max(30) deadlineDays?: number;
  @IsOptional() @IsBoolean() applyOnlineDefault?: boolean;
  @IsOptional() @IsString() publicApplyBaseUrl?: string;
  @IsOptional() @IsInt() @Min(0) @Max(20) entryLevelMaxYears?: number;
  @IsOptional() @IsInt() @Min(1) @Max(30) midLevelMaxYears?: number;
}

/** Credentials to test — omitted/blank fields fall back to the saved ones. */
class TestBdJobsDto {
  @IsOptional() @IsString() baseUrl?: string;
  @IsOptional() @IsString() companyId?: string;
  @IsOptional() @IsString() authToken?: string;
  @IsOptional() @IsString() decodeId?: string;
  @IsOptional() @IsString() signatureFormat?: string;
}

@Controller()
export class BdJobsController {
  constructor(
    private readonly bdjobs: BdJobsService,
    private readonly settings: BdJobsSettingsService,
  ) {}

  /** Full config for the admin screen — credentials returned masked. */
  @Roles(UserRole.ADMIN)
  @Get('integrations/bdjobs/settings')
  getSettings() {
    return this.settings.getView();
  }

  @Roles(UserRole.ADMIN)
  @Patch('integrations/bdjobs/settings')
  updateSettings(@Body() dto: UpdateBdJobsSettingsDto) {
    return this.settings.set(dto);
  }

  /**
   * Verify credentials against BDJobs without creating a listing. The admin
   * screen posts the values currently in the form so "Test" checks what's on
   * screen (blank secrets fall back to the saved ones).
   */
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('integrations/bdjobs/test')
  test(@Body() dto: TestBdJobsDto) {
    return this.bdjobs.testConnection(dto);
  }

  /** Proxy — BDJobs location search (used by the modal's location picker). */
  @Get('integrations/bdjobs/locations')
  searchLocations(@Query('search') search?: string) {
    return this.bdjobs.searchLocations(search);
  }

  /** Proxy — BDJobs full category list (filter client-side). */
  @Get('integrations/bdjobs/categories')
  getCategories() {
    return this.bdjobs.getCategories();
  }

  /** Education levels (hardcoded — no BDJobs API). */
  @Get('integrations/bdjobs/education-levels')
  getEduLevels() {
    return this.bdjobs.getEduLevels();
  }

  /** Degrees for a given education level ID. */
  @Get('integrations/bdjobs/degrees')
  getDegrees(@Query('eduLevelId', ParseIntPipe) eduLevelId: number) {
    return this.bdjobs.getDegrees(eduLevelId);
  }

  /** Industry auto-suggestion (search-based). */
  @Get('integrations/bdjobs/industry')
  searchIndustry(@Query('searchtxt') searchtxt: string) {
    return this.bdjobs.searchIndustry(searchtxt ?? '');
  }

  /** Skills & expertise (search + optional category context). */
  @Get('integrations/bdjobs/skills')
  searchSkills(
    @Query('search') search: string,
    @Query('catId') catId?: string,
  ) {
    return this.bdjobs.searchSkills(
      search ?? '',
      catId ? Number(catId) : undefined,
    );
  }

  /** Get existing BDJobs post data for a requisition. */
  @Get('requisitions/:reqId/bdjobs')
  getPost(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.bdjobs.getPost(reqId, user.id);
  }

  /** Save form data and post (or save as draft if no credentials). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('requisitions/:reqId/bdjobs/post')
  post(
    @Param('reqId') reqId: string,
    @Body() dto: PostBdJobsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bdjobs.saveAndPost(
      reqId,
      dto as unknown as PostBdJobsFormData,
      user.id,
    );
  }

  /** Whether BDJobs posting is enabled + configured (gates the modal). */
  @Get('integrations/bdjobs/status')
  async status() {
    return { configured: await this.bdjobs.isConfigured() };
  }

  /**
   * Inbound webhook — Bdjobs calls this endpoint to push candidates who applied
   * via the Bdjobs portal. No JWT; authenticated by SHA-256 signature in
   * X-Api-AuthToken. Returns the ZinqHR response contract directly (message
   * at top level, not wrapped by ResponseInterceptor).
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(200)
  @Post('integrations/bdjobs/candidates')
  async receiveCandidate(
    @Body() dto: BdJobsInboundCandidateDto,
    @Headers('x-api-authtoken') authToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.bdjobs.receiveCandidate(dto, authToken);
    res.json(result);
  }
}
