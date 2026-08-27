import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionsService } from '../../rbac/permissions.service';
import type {
  BdJobsCategory,
  BdJobsDegree,
  BdJobsIndustry,
  BdJobsLocation,
  BdJobsSkill,
  PostBdJobsFormData,
} from './bdjobs.types';
import { EDU_LEVELS } from './bdjobs.types';
import { BdJobsInboundCandidateDto } from './dto/bdjobs-inbound.dto';
import {
  BdJobsSettingsService,
  type BdJobsSettings,
} from './bdjobs-settings.service';

const BDJOBS_API = 'https://api.bdjobs.com/EmployerApi/api';

@Injectable()
export class BdJobsService {
  private readonly logger = new Logger(BdJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly permissions: PermissionsService,
    private readonly settings: BdJobsSettingsService,
  ) {}

  async isConfigured(): Promise<boolean> {
    const s = await this.settings.get();
    return Boolean(s.enabled && s.authToken && s.decodeId && s.companyId);
  }

  /** BDJobs posting is a recruitment action — Corporate HR / CHRO / super only. */
  private async requireAccess(requisitionId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: requisitionId },
      select: { id: true, code: true, unitFactory: true, posting: true },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    const allowed =
      (await this.permissions.hasRoleForUnitName(
        userId,
        'corporate_hr',
        req.unitFactory,
      )) ||
      (await this.permissions.hasRoleForUnitName(
        userId,
        'chro',
        req.unitFactory,
      ));
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can post to BDJobs',
      );
    }
    return req;
  }

  /**
   * BDJobs' X-Api-AuthToken: SHA-256 over their documented template —
   * Token + "&^^" + DecodeID + "*&*" + ts (admin-editable in settings).
   */
  private signature(s: BdJobsSettings, ts: string): string {
    const raw = s.signatureFormat
      .replace(/\{token\}/gi, s.authToken)
      .replace(/\{decodeId\}/gi, s.decodeId)
      .replace(/\{companyId\}/gi, s.companyId)
      .replace(/\{ts\}/gi, ts);
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Verify credentials without creating a listing: send a deliberately
   * incomplete job (no title). BDJobs authenticates first, so "Job Title Empty"
   * means the signature + company were accepted, while a bad company/signature
   * comes back as 1011/1012/1014. Overrides let the admin screen test the
   * values currently typed in the form, not just the saved ones.
   */
  async testConnection(
    overrides: Partial<BdJobsSettings> = {},
  ): Promise<{ ok: boolean; message: string }> {
    const saved = await this.settings.get();
    const s: BdJobsSettings = {
      ...saved,
      ...overrides,
      // Blank secret fields mean "use the stored one" (the UI never sees them).
      authToken: overrides.authToken?.trim() || saved.authToken,
      decodeId: overrides.decodeId?.trim() || saved.decodeId,
      companyId: overrides.companyId?.trim() || saved.companyId,
      baseUrl: overrides.baseUrl?.trim() || saved.baseUrl,
      signatureFormat:
        overrides.signatureFormat?.trim() || saved.signatureFormat,
    };
    if (!s.authToken || !s.decodeId || !s.companyId) {
      return { ok: false, message: 'Credentials are incomplete.' };
    }
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(`${s.baseUrl}/api/Job/CAS/jobpostings`, {
        method: 'POST',
        headers: {
          'X-Api-AuthToken': this.signature(s, ts),
          companyID: s.companyId,
          'Content-Type': 'application/json',
        },
        // No JobTitle → BDJobs answers 1001/1015 *after* authenticating.
        body: JSON.stringify({ ts }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as { code?: number; message?: string };
      const code = body.code ?? 0;
      // Auth-layer failures: bad signature / company / token / permission.
      if ([1009, 1010, 1011, 1012, 1013, 1014].includes(code)) {
        return {
          ok: false,
          message: `${body.message ?? 'Rejected'} (${code})`,
        };
      }
      // We deliberately sent no job data — BDJobs complaining about the missing
      // title/fields proves it got past authentication.
      if ([1001, 1015].includes(code)) {
        return {
          ok: true,
          message: `Connected — BDJobs accepted company ${s.companyId} and the signature.`,
        };
      }
      return {
        ok: false,
        message: `Unexpected response from BDJobs: ${body.message ?? 'no message'} (${code}).`,
      };
    } catch (err) {
      return { ok: false, message: `Unreachable: ${(err as Error).message}` };
    }
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
      const res = await fetch(`${BDJOBS_API}/Degree?eduLevelId=${eduLevelId}`, {
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json()) as {
        data?: { id: number; degree_Name: string }[];
      };
      return (json.data ?? []).map((d) => ({
        id: d.id,
        name: d.degree_Name.trim(),
      }));
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
  async getPost(requisitionId: string, userId: string) {
    await this.requireAccess(requisitionId, userId);
    const post = await this.prisma.bdJobsPost.findUnique({
      where: { requisitionId },
    });
    return post ?? null;
  }

  /**
   * Save form data and attempt to post to BDJobs.
   * Without credentials it saves a draft; with them it calls the job-export
   * API. The BDJobs listing lands as "Pending Approval" on their side.
   */
  async saveAndPost(
    requisitionId: string,
    formData: PostBdJobsFormData,
    userId: string,
  ) {
    const req = await this.requireAccess(requisitionId, userId);

    // Always persist the form first — HR's work is never lost on a failure.
    const draft = await this.prisma.bdJobsPost.upsert({
      where: { requisitionId },
      create: {
        requisitionId,
        formData: formData as unknown as Prisma.InputJsonValue,
        status: 'draft',
      },
      update: {
        formData: formData as unknown as Prisma.InputJsonValue,
        errorMessage: null,
      },
    });

    const settings = await this.settings.get();
    if (!settings.enabled) {
      return {
        ...draft,
        note: 'BDJobs posting is turned off in Configuration — saved as draft.',
      };
    }
    if (!settings.authToken || !settings.decodeId || !settings.companyId) {
      return {
        ...draft,
        note: 'BDJobs API credentials not configured — saved as draft.',
      };
    }
    if (draft.status === 'posted' && draft.bdJobsJobId) {
      return {
        ...draft,
        note: `Already live on BDJobs (job #${draft.bdJobsJobId}).`,
      };
    }

    const { baseUrl, companyId } = settings;
    const payload = this.buildPayload(req, formData, settings);
    let body: {
      status?: string;
      code?: number;
      data?: { jobID?: number; Status?: string };
      message?: string;
    };
    try {
      const res = await fetch(`${baseUrl}/api/Job/CAS/jobpostings`, {
        method: 'POST',
        headers: {
          // Signed with the same `ts` that travels in the body.
          'X-Api-AuthToken': this.signature(settings, payload.ts),
          companyID: companyId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      body = (await res.json()) as typeof body;
    } catch (err) {
      const message = `BDJobs unreachable: ${(err as Error).message}`;
      await this.prisma.bdJobsPost.update({
        where: { requisitionId },
        data: { status: 'failed', errorMessage: message },
      });
      throw new ServiceUnavailableException(message);
    }

    if (body.status === 'success' && body.data?.jobID) {
      const post = await this.prisma.bdJobsPost.update({
        where: { requisitionId },
        data: {
          status: 'posted',
          bdJobsJobId: String(body.data.jobID),
          postedAt: new Date(),
          errorMessage: null,
        },
      });
      this.logger.log(
        `Posted ${req.code} to BDJobs — job #${body.data.jobID} (${body.data.Status ?? 'Pending Approval'})`,
      );
      return {
        ...post,
        note: `BDJobs job #${body.data.jobID} — ${body.data.Status ?? 'Pending Approval'}.`,
      };
    }

    // Duplicate reference (code 1016) = it's already on BDJobs from before.
    if (body.code === 1016) {
      const post = await this.prisma.bdJobsPost.update({
        where: { requisitionId },
        data: { status: 'posted', postedAt: draft.postedAt ?? new Date() },
      });
      return {
        ...post,
        note: 'BDJobs reports this requisition was already posted (duplicate reference).',
      };
    }

    const message = body.message || 'BDJobs rejected the posting.';
    await this.prisma.bdJobsPost.update({
      where: { requisitionId },
      data: { status: 'failed', errorMessage: message },
    });
    return { ...draft, status: 'failed', errorMessage: message };
  }

  /**
   * Map the modal's form + requisition context to BDJobs' payload. Rules
   * learned from BDJobs' spec and live testing:
   *  - dates are M/D/YYYY and the deadline must be ≤30 days out (else 1006);
   *  - jobReferenceId is capped at 15 chars (our REQ code fits);
   *  - optional fields must be omitted rather than sent empty (empty strings
   *    trigger a generic 1023 "Unexpected error");
   *  - multi-value fields (location / skills / experience areas) use "|".
   */
  private buildPayload(
    req: { id: string; code: string; posting: Prisma.JsonValue },
    f: PostBdJobsFormData,
    s: BdJobsSettings,
  ) {
    const mdy = (d: Date) =>
      `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

    // Deadline: from the internal posting step, but BDJobs only accepts a date
    // that is in the future and no more than 30 days out — an expired or
    // too-distant closing date is clamped into the configured window.
    const posting = req.posting as { closingDate?: string } | null;
    const minDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const maxDeadline = new Date(
      Date.now() + s.deadlineDays * 24 * 60 * 60 * 1000,
    );
    let deadline = posting?.closingDate
      ? new Date(posting.closingDate)
      : maxDeadline;
    if (Number.isNaN(deadline.getTime()) || deadline > maxDeadline) {
      deadline = maxDeadline;
    } else if (deadline < minDeadline) {
      deadline = maxDeadline; // already closed internally — give BDJobs a live window
    }

    const employment: Record<string, string> = {
      full_time: 'Full-Time',
      part_time: 'Part-Time',
      contractual: 'Contract',
      internship: 'Internship',
      freelance: 'Freelance',
    };
    const gender: Record<string, string> = {
      all: 'Both',
      male: 'Male',
      female: 'Female',
      others: 'Both',
    };
    const years = f.experienceYears ?? 0;
    const education = [
      f.educationDegreeName || f.educationLevelName,
      f.educationConcentration && `in ${f.educationConcentration}`,
    ]
      .filter(Boolean)
      .join(' ');

    const origin =
      s.publicApplyBaseUrl ||
      this.config.get<string>('frontendUrl') ||
      'http://localhost:3000';
    if (f.applyOnline && origin.includes('localhost')) {
      // Silent misconfiguration would otherwise post a real, live job ad to
      // BDJobs with an apply link nobody outside this machine can reach — log
      // loudly rather than let it slip through unnoticed.
      this.logger.error(
        `BDJobs applyUrl resolved to a localhost origin (${origin}) — set publicApplyBaseUrl in Configuration → Integrations → BDJobs, or FRONTEND_URL, before posting live jobs.`,
      );
    }
    const applyUrl = f.applyOnline
      ? `${origin.split(',')[0].replace(/\/$/, '')}/apply/${req.id}`
      : '';

    const payload: Record<string, string | number> = {
      ts: String(Math.floor(Date.now() / 1000)),
      JobTitle: f.jobTitle,
      Vacancies: String(f.vacancyNo),
      JobCategory: f.categoryId ?? 8,
      EmploymentStatus: employment[f.employmentStatus[0]] ?? 'Full-Time',
      ApplicationDeadline: mdy(deadline),
      SpecialInstruction: s.specialInstruction,
      JobLevel:
        years < s.entryLevelMaxYears
          ? 'Entry'
          : years < s.midLevelMaxYears
            ? 'Mid'
            : 'Top',
      JobResponsibilities: f.jobDescription,
      JobLocation: f.locationNames.join('|') || 'Anywhere in Bangladesh',
      SalaryMin: String(f.salaryMin ?? 0),
      SalaryMax: String(f.salaryMax ?? 0),
      OtherBenefits: s.otherBenefits,
      EducationalQualification: education || 'As per job requirements',
      ExperienceMin: String(years),
      ExperienceMax: String(years + 4),
      Fresher: years === 0 ? '1' : '0',
      AdditionalRequirements:
        f.additionalRequirements || 'As per job requirements.',
      Gender: f.restrictGender ? (gender[f.preferredGender] ?? 'Both') : 'Both',
      // ≤15 chars; stable per requisition so BDJobs blocks re-posts (1016).
      jobReferenceId: req.code.slice(0, 15),
      JobPublishedDate: mdy(new Date()),
    };

    // Optional fields — only send when non-empty (empty values cause 1023).
    const areas = f.industryExperience
      .map((i) => i.name)
      .filter(Boolean)
      .join('|');
    if (areas) payload.AreaExperience = areas;
    const skills = f.skills
      .map((s) => s.name)
      .filter(Boolean)
      .join('|');
    if (skills) payload.Skills = skills;
    if (f.restrictAge && f.ageMin != null) payload.AgeMin = String(f.ageMin);
    if (f.restrictAge && f.ageMax != null) payload.AgeMax = String(f.ageMax);
    if (applyUrl) payload.ApplyURL = applyUrl;

    return payload as typeof payload & { ts: string };
  }

  /**
   * Inbound webhook: Bdjobs POSTs candidate data to us whenever someone applies
   * through their job portal. We verify the shared-secret SHA-256 signature,
   * match the job reference to a requisition, deduplicate by Bdjobs applicationId,
   * and create the candidate record.
   *
   * Returns the ZinqHR response contract directly (not wrapped by ResponseInterceptor).
   */
  async receiveCandidate(
    dto: BdJobsInboundCandidateDto,
    incomingSignature: string | undefined,
  ): Promise<{
    success: boolean;
    data: {
      candidateId: string;
      requisitionCode: string;
      status: string;
      duplicate: boolean;
    } | null;
    message: string;
  }> {
    // 1. Verify SHA-256 signature using the same shared credentials.
    const settings = await this.settings.get();
    if (!settings.authToken || !settings.decodeId) {
      throw new ServiceUnavailableException(
        'BDJobs credentials are not configured.',
      );
    }
    const expected = createHash('sha256')
      .update(`${settings.authToken}&^^${settings.decodeId}*&*${dto.ts}`)
      .digest('hex');
    if (!incomingSignature || incomingSignature !== expected) {
      throw new UnauthorizedException('Invalid X-Api-AuthToken signature.');
    }

    // 2. Reject stale/replayed requests (5-minute window).
    const drift = Math.abs(Math.floor(Date.now() / 1000) - dto.ts);
    if (drift > 300) {
      throw new UnauthorizedException('Request timestamp is expired.');
    }

    // 3. Resolve the requisition by jobReferenceId (our code) or bdJobsJobId.
    let requisition: { id: string; code: string } | null = null;

    if (dto.jobReferenceId) {
      requisition = await this.prisma.requisition.findFirst({
        where: { code: dto.jobReferenceId },
        select: { id: true, code: true },
      });
    }

    if (!requisition && dto.bdJobsJobId) {
      const post = await this.prisma.bdJobsPost.findFirst({
        where: { bdJobsJobId: dto.bdJobsJobId },
        select: { requisitionId: true },
      });
      if (post) {
        requisition = await this.prisma.requisition.findUnique({
          where: { id: post.requisitionId },
          select: { id: true, code: true },
        });
      }
    }

    if (!requisition) {
      throw new NotFoundException(
        `No requisition found for jobReferenceId "${dto.jobReferenceId ?? ''}" or bdJobsJobId "${dto.bdJobsJobId}".`,
      );
    }

    // 4. Deduplicate by Bdjobs applicationId (globally unique per application).
    const existing = await this.prisma.candidate.findFirst({
      where: { bdjobsApplicationId: dto.applicationId },
      select: { id: true },
    });
    if (existing) {
      return {
        success: true,
        data: {
          candidateId: existing.id,
          requisitionCode: requisition.code,
          status: 'duplicate',
          duplicate: true,
        },
        message: 'Candidate has already applied to this job.',
      };
    }

    // 5. Create candidate record — CV is a public URL; no Drive upload here.
    const candidate = await this.prisma.candidate.create({
      data: {
        requisitionId: requisition.id,
        name: dto.candidate.name,
        email: dto.candidate.email,
        phone: dto.candidate.phone ?? null,
        source: 'bdjobs',
        cvUrl: dto.resume.url,
        bdjobsApplicationId: dto.applicationId,
        bdjobsApplicantId: dto.profile.bdjobsApplicantId,
        bdjobsJobId: dto.bdJobsJobId,
      },
    });

    this.logger.log(
      `BDJobs candidate imported: ${candidate.id} (${dto.candidate.name}) → ${requisition.code}`,
    );

    return {
      success: true,
      data: {
        candidateId: candidate.id,
        requisitionCode: requisition.code,
        status: 'imported',
        duplicate: false,
      },
      message: 'Candidate imported successfully',
    };
  }
}
