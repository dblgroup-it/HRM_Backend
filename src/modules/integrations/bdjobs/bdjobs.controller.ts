import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';

import { BdJobsService } from './bdjobs.service';
import { PostBdJobsDto } from './dto/bdjobs.dto';

@Controller()
export class BdJobsController {
  constructor(private readonly bdjobs: BdJobsService) {}

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
    return this.bdjobs.searchSkills(search ?? '', catId ? Number(catId) : undefined);
  }

  /** Get existing BDJobs post data for a requisition. */
  @Get('requisitions/:reqId/bdjobs')
  getPost(@Param('reqId') reqId: string) {
    return this.bdjobs.getPost(reqId);
  }

  /** Save form data and post (or save as draft if no credentials). */
  @Post('requisitions/:reqId/bdjobs/post')
  post(@Param('reqId') reqId: string, @Body() dto: PostBdJobsDto) {
    return this.bdjobs.saveAndPost(reqId, dto as any);
  }

  /** Check if BDJobs credentials are configured. */
  @Get('integrations/bdjobs/status')
  status() {
    return { configured: this.bdjobs.isConfigured() };
  }
}
