import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../prisma/prisma.service';
import type {
  BdJobsCategory,
  BdJobsDegree,
  BdJobsIndustry,
  BdJobsLocation,
  BdJobsSkill,
  PostBdJobsFormData,
} from './bdjobs.types';
import { EDU_LEVELS } from './bdjobs.types';

const BDJOBS_API = 'https://api.bdjobs.com/EmployerApi/api';

@Injectable()
export class BdJobsService {
  private readonly logger = new Logger(BdJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('bdjobs.clientId'));
  }

  /** Proxy BDJobs location search. Empty search returns top-level locations. */
  async searchLocations(search?: string): Promise<BdJobsLocation[]> {
    try {
      const url = search
        ? `${BDJOBS_API}/Location?search=${encodeURIComponent(search)}`
        : `${BDJOBS_API}/Location`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = (await res.json()) as { data?: BdJobsLocation[] };
      return json.data ?? [];
    } catch (err) {
      this.logger.warn(`BDJobs location search failed: ${String(err)}`);
      return [];
    }
  }

  /** Proxy BDJobs job categories (full list — filtered client-side). */
  async getCategories(): Promise<BdJobsCategory[]> {
    try {
      const res = await fetch(`${BDJOBS_API}/JobCategory`, {
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json()) as { data?: BdJobsCategory[] };
      return (json.data ?? []).map((c) => ({ ...c, name: c.name.trim() }));
    } catch (err) {
      this.logger.warn(`BDJobs category fetch failed: ${String(err)}`);
      return [];
    }
  }

  /** Hardcoded education levels (no BDJobs API for this). */
  getEduLevels() {
    return EDU_LEVELS;
  }

  /** Proxy BDJobs degrees for a given education level. */
  async getDegrees(eduLevelId: number): Promise<BdJobsDegree[]> {
    try {
      const res = await fetch(
        `${BDJOBS_API}/Degree?eduLevelId=${eduLevelId}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const json = (await res.json()) as {
        data?: { id: number; degree_Name: string }[];
      };
      return (json.data ?? []).map((d) => ({ id: d.id, name: d.degree_Name.trim() }));
    } catch (err) {
      this.logger.warn(`BDJobs degree fetch failed: ${String(err)}`);
      return [];
    }
  }

  /** Proxy BDJobs skills & expertise (search + category context). */
  async searchSkills(search: string, catId?: number): Promise<BdJobsSkill[]> {
    if (!search.trim()) return [];
    try {
      const params = new URLSearchParams({ search });
      if (catId) params.set('catId', String(catId));
      const res = await fetch(`${BDJOBS_API}/SkillAndExpertise?${params}`, {
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json()) as {
        data?: { id: number; value: string }[];
      };
      return (json.data ?? []).map((s) => ({ id: s.id, name: s.value.trim() }));
    } catch (err) {
      this.logger.warn(`BDJobs skill search failed: ${String(err)}`);
      return [];
    }
  }

  /** Proxy BDJobs industry auto-suggestion (search-based). */
  async searchIndustry(searchtxt: string): Promise<BdJobsIndustry[]> {
    if (!searchtxt.trim()) return [];
    try {
      const res = await fetch(
        `${BDJOBS_API}/JobPosting/IndustryAutoSuggestion?searchtxt=${encodeURIComponent(searchtxt)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const json = (await res.json()) as {
        data?: { organizationType_ID: string; organizationType_Name: string }[];
      };
      return (json.data ?? []).map((d) => ({
        id: d.organizationType_ID,
        name: d.organizationType_Name.trim(),
      }));
    } catch (err) {
      this.logger.warn(`BDJobs industry search failed: ${String(err)}`);
      return [];
    }
  }

  /** Get an existing BDJobs post for a requisition (or null). */
  async getPost(requisitionId: string) {
    const post = await this.prisma.bdJobsPost.findUnique({
      where: { requisitionId },
    });
    return post ?? null;
  }

  /**
   * Save form data and attempt to post to BDJobs.
   * If credentials are not configured, saves as draft and returns status=draft.
   * When credentials become available, re-submitting will actually post.
   */
  async saveAndPost(requisitionId: string, formData: PostBdJobsFormData) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: requisitionId },
      select: { id: true, code: true, designation: true, drive: true },
    });
    if (!req) throw new NotFoundException('Requisition not found');

    if (!this.isConfigured()) {
      // Save the draft so HR doesn't lose their work
      const post = await this.prisma.bdJobsPost.upsert({
        where: { requisitionId },
        create: { requisitionId, formData: formData as any, status: 'draft' },
        update: { formData: formData as any, status: 'draft', errorMessage: null },
      });
      return { ...post, note: 'BDJobs API credentials not configured — saved as draft.' };
    }

    // ── When credentials are available, call BDJobs API here ──────────────
    // const clientId = this.config.get<string>('bdjobs.clientId');
    // const clientSecret = this.config.get<string>('bdjobs.clientSecret');
    // const token = await this.authenticate(clientId, clientSecret);
    // const bdJobsId = await this.createJob(token, req, formData);
    // ──────────────────────────────────────────────────────────────────────

    // Until the above is wired, throw so caller knows
    throw new ServiceUnavailableException(
      'BDJobs API credentials are configured but posting is not yet implemented. Coming soon.',
    );
  }
}
