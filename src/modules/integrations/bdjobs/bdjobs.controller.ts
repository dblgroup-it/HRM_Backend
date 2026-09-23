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
  UseFilters,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

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
import {
  BdJobsInboundFilter,
  bdjobsInboundValidation,
} from './bdjobs-inbound.errors';
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
   * Put the shipped configuration back in one call — base URL, signature
   * template, posting defaults and level thresholds. Credentials, company ID
   * and the on/off switch are kept: they are the half nobody can retype.
   */
  @Roles(UserRole.ADMIN)
  @Post('integrations/bdjobs/settings/restore')
  restoreSettings() {
    return this.settings.restoreDefaults();
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

  /**
   * Whether BDJobs posting is enabled + configured (gates the modal), plus the
   * application window, so the posting form can show the deadline the listing
   * will actually carry instead of leaving the recruiter to guess it.
   */
  @Get('integrations/bdjobs/status')
  async status() {
    const [configured, settings] = await Promise.all([
      this.bdjobs.isConfigured(),
      this.settings.get(),
    ]);
    return { configured, deadlineDays: settings.deadlineDays };
  }

  /**
   * Inbound webhook — Bdjobs calls this endpoint to push candidates who applied
   * via the Bdjobs portal. No JWT; authenticated by SHA-256 signature in
   * X-Api-AuthToken.
   *
   * Bypasses the global ResponseInterceptor/HttpExceptionFilter: both success
   * and failure answer in Bdjobs' documented shape, `{ success, data, message }`,
   * with `message` always a readable string. Failures add a `code` to branch on,
   * a `hint` saying what to change, and — for a rejected payload — the exact
   * fields that were wrong, so an integration problem can be diagnosed from the
   * response instead of from our logs.
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(200)
  @UseFilters(BdJobsInboundFilter)
  @Post('integrations/bdjobs/candidates')
  async receiveCandidate(
    @Body(bdjobsInboundValidation) dto: BdJobsInboundCandidateDto,
    @Headers('x-api-authtoken') authToken: string | undefined,
    // Written directly so the global ResponseInterceptor cannot wrap the body
    // in a second { success, data } envelope. Failures are shaped by
    // BdJobsInboundFilter, which also catches the validation pipe above.
    @Res() res: Response,
  ): Promise<void> {
    res.json(await this.bdjobs.receiveCandidate(dto, authToken));
  }
}
