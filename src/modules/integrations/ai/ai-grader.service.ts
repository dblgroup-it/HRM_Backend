import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GradeInput {
  prompt: string;
  modelAnswer?: string | null;
  candidateAnswer: string;
  maxMarks: number;
}

export interface GradeResult {
  score: number;
  feedback: string;
}

export interface ExtractInput {
  /** What kind of document this is, e.g. "National ID / Passport". */
  label: string;
  mimeType: string;
  /** Base64-encoded file bytes. */
  base64: string;
}

export interface ExtractResult {
  summary: string;
  fields: Record<string, string>;
}

export interface RoleProfileInput {
  designation: string;
  department: string;
  unitFactory: string;
  placeOfPosting: string;
  jobDescription: string;
  education: string;
  experience: string;
  others?: string | null;
  requiredPosts: number;
  employmentNature?: string;
  /** Optional context from an existing role profile (used for question gen). */
  responsibilities?: string[];
  requirements?: string[];
}

export interface RoleProfileResult {
  summary: string;
  jobDescription: string;
  responsibilities: string[];
  requirements: string[];
}

export interface InterviewQuestion {
  category: string;
  question: string;
}

export interface ScreenInput {
  cvMimeType: string;
  cvBase64: string;
  designation: string;
  jobDescription: string;
  education: string;
  experience: string;
  others?: string | null;
  responsibilities?: string[];
  requirements?: string[];
}

export interface ScreenResult {
  /** 0-100 match against the role. */
  score: number;
  summary: string;
  /** Contact details detected in the CV (null if not found / not valid). */
  email: string | null;
  phone: string | null;
}

export interface CrossCheckInput {
  candidate: { name: string; email?: string | null; phone?: string | null };
  role: { designation: string; education: string; experience: string };
  docs: {
    label: string;
    summary: string;
    fields: Record<string, string>;
  }[];
}

export interface CrossCheckFinding {
  /** Which document(s) the issue concerns, by label. */
  doc: string;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
}

export interface CrossCheckResult {
  verdict: 'consistent' | 'minor_issues' | 'discrepancies';
  overview: string;
  findings: CrossCheckFinding[];
}

export interface CompareFinalistInput {
  role: {
    designation: string;
    department: string;
    jobDescription: string;
    requirements: string[];
  };
  finalists: {
    id: string;
    name: string;
    stage: string;
    matchScore: number | null;
    matchSummary: string | null;
    exams: { type: string; score: number; maxScore: number }[];
    interviews: {
      kind: string;
      avgTotal: number;
      evaluations: number;
      comments: string[];
    }[];
  }[];
}

export interface FinalistRanking {
  id: string;
  rank: number;
  strengths: string[];
  risks: string[];
  verdict: string;
}

export interface CompareFinalistsResult {
  recommendation: string;
  ranking: FinalistRanking[];
}

export interface RouteCvInput {
  subject: string;
  bodyText: string;
  cvMimeType: string;
  cvBase64: string;
  /** The open (posted) requisitions the CV could belong to. */
  openings: {
    code: string;
    designation: string;
    department: string;
    unit: string;
  }[];
}

export interface RouteCvResult {
  /** Matched requisition code, or null when nothing fits. */
  code: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

interface GeminiResp {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}
interface ClaudeResp {
  content?: { text?: string }[];
}

/**
 * Provider-agnostic AI grader for written exam answers. Uses Gemini or Claude
 * depending on `AI_PROVIDER`; switching providers is a one-line config change.
 * Calls the providers' REST APIs directly (no SDK dependency).
 */
@Injectable()
export class AiGraderService {
  private readonly logger = new Logger(AiGraderService.name);

  constructor(private readonly config: ConfigService) {}

  get provider(): string {
    return (this.config.get<string>('ai.provider') ?? 'gemini').toLowerCase();
  }

  isConfigured(): boolean {
    return this.provider === 'claude'
      ? Boolean(this.config.get<string>('ai.anthropic.apiKey'))
      : Boolean(this.config.get<string>('ai.gemini.apiKey'));
  }

  /**
   * Free-text completion for analytics/chat (HR insights). Returns plain text,
   * not JSON. Used by the "Ask your HR data", weekly digest and bottleneck
   * features.
   */
  async complete(prompt: string, maxTokens = 900): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    return this.provider === 'claude'
      ? this.callClaude(prompt, maxTokens)
      : this.callGeminiText(prompt);
  }

  private async callGeminiText(text: string): Promise<string> {
    const model = this.config.get<string>('ai.gemini.model');
    const key = this.config.get<string>('ai.gemini.apiKey') ?? '';
    const res = await this.fetchJson<GeminiResp>(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: { temperature: 0.3 },
        }),
      },
    );
    return res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  async grade(input: GradeInput): Promise<GradeResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI grading is not configured');
    }
    const promptText = this.buildPrompt(input);
    const raw =
      this.provider === 'claude'
        ? await this.callClaude(promptText)
        : await this.callGemini(promptText);
    return this.parse(raw, input.maxMarks);
  }

  /**
   * OCR + extract structured fields from a candidate document (image or PDF).
   * Used by onboarding's "Doc summary (AI)" step.
   */
  async extractDocument(input: ExtractInput): Promise<ExtractResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI extraction is not configured');
    }
    const supported =
      input.mimeType.startsWith('image/') ||
      input.mimeType === 'application/pdf';
    if (!supported) {
      return {
        summary: `Automatic extraction isn't available for ${input.mimeType} files — please review this document manually.`,
        fields: {},
      };
    }
    const prompt = this.buildExtractPrompt(input.label);
    const raw =
      this.provider === 'claude'
        ? await this.callClaudeVision(prompt, input.mimeType, input.base64)
        : await this.callGeminiVision(prompt, input.mimeType, input.base64);
    return this.parseExtract(raw);
  }

  private buildExtractPrompt(label: string): string {
    return `You are a meticulous HR document-verification assistant. The attached file is a candidate's "${label}". Read it carefully (use OCR) and extract the key identifying details.

Respond with ONLY a compact JSON object and nothing else:
{"summary":"<one or two plain-language sentences describing the document and its key details>","fields":{"<Field Name>":"<value>"}}

Use clear field names that match the document, for example: Full Name, Document Number, Date of Birth, Issue Date, Expiry Date, Address, Institution, Degree, Year, Result, Issuing Authority. Only include fields you can actually read. If the file is unreadable, say so in "summary" and return an empty "fields" object.`;
  }

  private async callGeminiVision(
    text: string,
    mimeType: string,
    base64: string,
  ): Promise<string> {
    const model = this.config.get<string>('ai.gemini.model');
    const key = this.config.get<string>('ai.gemini.apiKey') ?? '';
    const res = await this.fetchJson<GeminiResp>(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text },
                { inline_data: { mime_type: mimeType, data: base64 } },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
          },
        }),
      },
    );
    return res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  private async callClaudeVision(
    text: string,
    mimeType: string,
    base64: string,
  ): Promise<string> {
    const model = this.config.get<string>('ai.anthropic.model');
    const key = this.config.get<string>('ai.anthropic.apiKey') ?? '';
    const fileBlock =
      mimeType === 'application/pdf'
        ? {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          }
        : {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64 },
          };
    const res = await this.fetchJson<ClaudeResp>(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          messages: [
            { role: 'user', content: [{ type: 'text', text }, fileBlock] },
          ],
        }),
      },
    );
    return res.content?.[0]?.text ?? '';
  }

  private parseExtract(raw: string): ExtractResult {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : raw) as {
        summary?: unknown;
        fields?: unknown;
      };
      const fields: Record<string, string> = {};
      if (obj.fields && typeof obj.fields === 'object') {
        for (const [k, v] of Object.entries(
          obj.fields as Record<string, unknown>,
        )) {
          if (v != null && String(v).trim())
            fields[k] = String(v).slice(0, 300);
        }
      }
      return {
        summary: String(obj.summary ?? '').slice(0, 600),
        fields,
      };
    } catch {
      this.logger.warn(
        `Could not parse AI extraction output: ${raw.slice(0, 120)}`,
      );
      return { summary: '', fields: {} };
    }
  }

  /**
   * Generate a polished job role profile from a requisition's details. Used by
   * Corporate HR's "generate role profile" step before a vacancy is posted.
   */
  async generateRoleProfile(
    input: RoleProfileInput,
  ): Promise<RoleProfileResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const prompt = this.buildRoleProfilePrompt(input);
    const raw =
      this.provider === 'claude'
        ? await this.callClaude(prompt)
        : await this.callGemini(prompt);
    return this.parseRoleProfile(raw);
  }

  /**
   * Screen a candidate's CV (image/PDF) against a role and return a 0-100 match
   * score with a short rationale. Used by the AI Shortlisting stage.
   */
  async screenCv(input: ScreenInput): Promise<ScreenResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const supported =
      input.cvMimeType.startsWith('image/') ||
      input.cvMimeType === 'application/pdf';
    if (!supported) {
      return {
        score: 0,
        summary: `CV format (${input.cvMimeType}) can't be read by AI — please review manually.`,
        email: null,
        phone: null,
      };
    }
    const prompt = this.buildScreenPrompt(input);
    const raw =
      this.provider === 'claude'
        ? await this.callClaudeVision(prompt, input.cvMimeType, input.cvBase64)
        : await this.callGeminiVision(prompt, input.cvMimeType, input.cvBase64);
    return this.parseScreen(raw);
  }

  private buildScreenPrompt(i: ScreenInput): string {
    const list = (arr?: string[]) =>
      arr && arr.length
        ? arr.map((x) => `- ${x}`).join('\n')
        : '(none specified)';
    return `You are a recruitment screening assistant. Read the attached candidate CV and judge how well it fits the role below. Be objective and evidence-based.

ROLE: ${i.designation}
Job description: ${i.jobDescription || '(none)'}
Required education: ${i.education}
Required experience: ${i.experience}
Other requirements: ${i.others?.trim() || '(none)'}
Key responsibilities:
${list(i.responsibilities)}
Key requirements:
${list(i.requirements)}

Also extract the candidate's contact email and mobile/phone number if they appear anywhere in the CV (else leave them empty).

Score the overall fit from 0 to 100 (100 = ideal match). Weigh relevant experience, education, skills and domain. Respond with ONLY a compact JSON object and nothing else:
{"score": <integer 0-100>, "summary": "<one or two sentences: key strengths and any gaps vs. the role>", "email": "<email found in the CV or empty>", "phone": "<phone/mobile found in the CV or empty>"}`;
  }

  private parseScreen(raw: string): ScreenResult {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : raw) as {
        score?: unknown;
        summary?: unknown;
        email?: unknown;
        phone?: unknown;
      };
      const score = Math.max(
        0,
        Math.min(100, Math.round(Number(obj.score) || 0)),
      );
      const emailRaw = String(obj.email ?? '').trim();
      const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw)
        ? emailRaw.slice(0, 160)
        : null;
      const phoneRaw = String(obj.phone ?? '').trim();
      const phone =
        phoneRaw.replace(/\D/g, '').length >= 7 ? phoneRaw.slice(0, 40) : null;
      return {
        score,
        summary: String(obj.summary ?? '').slice(0, 500),
        email,
        phone,
      };
    } catch {
      this.logger.warn(
        `Could not parse AI screening output: ${raw.slice(0, 120)}`,
      );
      return { score: 0, summary: '', email: null, phone: null };
    }
  }

  /**
   * Route an emailed CV to one of the open requisitions by reading the email
   * subject/body and the CV itself. Used when the subject carries no code.
   */
  async routeCv(input: RouteCvInput): Promise<RouteCvResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const supported =
      input.cvMimeType.startsWith('image/') ||
      input.cvMimeType === 'application/pdf';
    const openings = input.openings
      .map((o) => `- ${o.code}: ${o.designation} · ${o.department} · ${o.unit}`)
      .join('\n');
    const prompt = `You are a recruitment mail-room assistant. A candidate emailed a CV. Decide which ONE of the open vacancies below it is applying for, based on the email subject/body${supported ? ' and the attached CV' : ''}.

OPEN VACANCIES
${openings}

EMAIL
Subject: ${input.subject || '(none)'}
Body: ${input.bodyText || '(empty)'}

Pick a vacancy ONLY when the evidence genuinely points to it (role named in the email, or the CV's profession clearly fits exactly one opening). If several fit equally or none fit, return null.

Respond with ONLY a compact JSON object and nothing else:
{"code":"<vacancy code or null>","confidence":"high|medium|low","reason":"<one short sentence>"}`;
    const raw = supported
      ? this.provider === 'claude'
        ? await this.callClaudeVision(prompt, input.cvMimeType, input.cvBase64)
        : await this.callGeminiVision(prompt, input.cvMimeType, input.cvBase64)
      : this.provider === 'claude'
        ? await this.callClaude(prompt)
        : await this.callGemini(prompt);
    return this.parseRoute(
      raw,
      input.openings.map((o) => o.code),
    );
  }

  private parseRoute(raw: string, validCodes: string[]): RouteCvResult {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : raw) as {
        code?: unknown;
        confidence?: unknown;
        reason?: unknown;
      };
      const codeRaw = String(obj.code ?? '').trim();
      const code =
        validCodes.find((c) => c.toLowerCase() === codeRaw.toLowerCase()) ??
        null;
      const confidences = ['high', 'medium', 'low'] as const;
      const confidence = confidences.includes(
        obj.confidence as (typeof confidences)[number],
      )
        ? (obj.confidence as RouteCvResult['confidence'])
        : 'low';
      return {
        code,
        confidence,
        reason: String(obj.reason ?? '').slice(0, 300),
      };
    } catch {
      this.logger.warn(`Could not parse AI routing: ${raw.slice(0, 120)}`);
      return { code: null, confidence: 'low', reason: '' };
    }
  }

  /**
   * Cross-check a candidate's submitted onboarding documents against their
   * profile and against each other — flags name/date/credential mismatches.
   */
  async crossCheckDocuments(input: CrossCheckInput): Promise<CrossCheckResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const prompt = this.buildCrossCheckPrompt(input);
    const raw =
      this.provider === 'claude'
        ? await this.callClaude(prompt, 900)
        : await this.callGemini(prompt);
    return this.parseCrossCheck(raw);
  }

  private buildCrossCheckPrompt(i: CrossCheckInput): string {
    const docBlocks = i.docs
      .map((d) => {
        const fields = Object.entries(d.fields)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        return `DOCUMENT "${d.label}"\nSummary: ${d.summary || '(none)'}\nExtracted fields:\n${fields || '  (none)'}`;
      })
      .join('\n\n');
    return `You are an HR document-verification auditor. A selected candidate submitted joining documents; each was already OCR-extracted. Cross-check the documents against the candidate's profile AND against each other.

CANDIDATE PROFILE (from the application)
Name: ${i.candidate.name}
Email: ${i.candidate.email || '(not on file)'}
Phone: ${i.candidate.phone || '(not on file)'}
Position: ${i.role.designation}
Required education: ${i.role.education || '(unspecified)'}
Required experience: ${i.role.experience || '(unspecified)'}

${docBlocks}

Check for: (1) name mismatches between documents and the application (allow obvious spelling/transliteration variants — flag those as "info", real differences as "critical"); (2) date inconsistencies (birth date differing across documents, certificates dated before birth, expired IDs); (3) education that does not satisfy the requirement; (4) anything internally contradictory or suspicious. Do NOT flag a document merely for missing optional fields.

Respond with ONLY a compact JSON object and nothing else:
{"verdict":"consistent|minor_issues|discrepancies","overview":"<1-2 sentence overall conclusion>","findings":[{"doc":"<document label or 'Profile'>","severity":"info|warning|critical","detail":"<specific, factual issue>"}]}
Use "consistent" with an empty findings array when everything lines up.`;
  }

  private parseCrossCheck(raw: string): CrossCheckResult {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : raw) as {
        verdict?: unknown;
        overview?: unknown;
        findings?: unknown;
      };
      const verdicts = ['consistent', 'minor_issues', 'discrepancies'] as const;
      const verdict = verdicts.includes(
        obj.verdict as (typeof verdicts)[number],
      )
        ? (obj.verdict as CrossCheckResult['verdict'])
        : 'minor_issues';
      const severities = ['info', 'warning', 'critical'] as const;
      const findings: CrossCheckFinding[] = Array.isArray(obj.findings)
        ? (obj.findings as unknown[])
            .map((f) => {
              const o = f as {
                doc?: unknown;
                severity?: unknown;
                detail?: unknown;
              };
              return {
                doc: String(o.doc ?? 'General').slice(0, 80),
                severity: severities.includes(
                  o.severity as (typeof severities)[number],
                )
                  ? (o.severity as CrossCheckFinding['severity'])
                  : 'warning',
                detail: String(o.detail ?? '').slice(0, 400),
              };
            })
            .filter((f) => f.detail)
            .slice(0, 12)
        : [];
      return {
        verdict,
        overview: String(obj.overview ?? '').slice(0, 500),
        findings,
      };
    } catch {
      this.logger.warn(`Could not parse AI cross-check: ${raw.slice(0, 120)}`);
      return { verdict: 'minor_issues', overview: '', findings: [] };
    }
  }

  /**
   * Compare interviewed finalists side-by-side and rank them for the final
   * selection decision. Purely advisory — the human decides.
   */
  async compareFinalists(
    input: CompareFinalistInput,
  ): Promise<CompareFinalistsResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const prompt = this.buildComparePrompt(input);
    const raw =
      this.provider === 'claude'
        ? await this.callClaude(prompt, 1400)
        : await this.callGemini(prompt);
    return this.parseCompare(
      raw,
      input.finalists.map((f) => f.id),
    );
  }

  private buildComparePrompt(i: CompareFinalistInput): string {
    const blocks = i.finalists
      .map((f) => {
        const exams = f.exams.length
          ? f.exams
              .map((e) => `  ${e.type}: ${e.score}/${e.maxScore}`)
              .join('\n')
          : '  (no exams)';
        const interviews = f.interviews.length
          ? f.interviews
              .map(
                (r) =>
                  `  ${r.kind} interview — avg panel score ${r.avgTotal} (${r.evaluations} evaluator${r.evaluations === 1 ? '' : 's'})${
                    r.comments.length
                      ? `; comments: ${r.comments.join(' | ')}`
                      : ''
                  }`,
              )
              .join('\n')
          : '  (no interview marks yet)';
        return `CANDIDATE id=${f.id}
Name: ${f.name} (stage: ${f.stage})
CV match score: ${f.matchScore ?? 'n/a'}/100${f.matchSummary ? ` — ${f.matchSummary}` : ''}
Exam results:
${exams}
Interviews:
${interviews}`;
      })
      .join('\n\n');
    return `You are advising DBL Group's Corporate HR on a final hiring decision. Compare the finalists below for the role, strictly on the evidence given (CV screening, exam scores, interview panel marks and comments). Be balanced — name genuine risks, not filler.

ROLE: ${i.role.designation} — ${i.role.department}
Job description: ${i.role.jobDescription || '(none)'}
Key requirements:
${i.role.requirements.map((r) => `- ${r}`).join('\n') || '(none)'}

${blocks}

Respond with ONLY a compact JSON object and nothing else:
{"recommendation":"<3-5 sentences: who you would hire and why, referencing the evidence>","ranking":[{"id":"<candidate id>","rank":<1=best>,"strengths":["<2-4 short items>"],"risks":["<1-3 short items>"],"verdict":"<one sentence on this candidate>"}]}
Include EVERY candidate exactly once, using the exact id values given.`;
  }

  private parseCompare(
    raw: string,
    validIds: string[],
  ): CompareFinalistsResult {
    const toItems = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .map((x) => String(x).trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : raw) as {
        recommendation?: unknown;
        ranking?: unknown;
      };
      const ranking: FinalistRanking[] = Array.isArray(obj.ranking)
        ? (obj.ranking as unknown[])
            .map((r) => {
              const o = r as {
                id?: unknown;
                rank?: unknown;
                strengths?: unknown;
                risks?: unknown;
                verdict?: unknown;
              };
              return {
                id: String(o.id ?? ''),
                rank: Math.max(1, Math.round(Number(o.rank) || 99)),
                strengths: toItems(o.strengths),
                risks: toItems(o.risks),
                verdict: String(o.verdict ?? '').slice(0, 300),
              };
            })
            .filter((r) => validIds.includes(r.id))
            .sort((a, b) => a.rank - b.rank)
        : [];
      return {
        recommendation: String(obj.recommendation ?? '').slice(0, 1200),
        ranking,
      };
    } catch {
      this.logger.warn(`Could not parse AI comparison: ${raw.slice(0, 120)}`);
      return { recommendation: '', ranking: [] };
    }
  }

  /** Generate role-specific interview questions for the panel. */
  async generateInterviewQuestions(
    input: RoleProfileInput,
  ): Promise<InterviewQuestion[]> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const prompt = `You are an expert interviewer at DBL Group. Generate a focused set of interview questions for the role below, tailored to its responsibilities and requirements.

Position: ${input.designation}
Department: ${input.department}
Job description: ${input.jobDescription || '(none)'}
Required education: ${input.education}
Required experience: ${input.experience}
Key responsibilities:
${(input.responsibilities ?? []).map((r) => `- ${r}`).join('\n') || '(none)'}
Key requirements:
${(input.requirements ?? []).map((r) => `- ${r}`).join('\n') || '(none)'}

Produce 10-14 questions grouped by category (e.g. "Technical", "Role-specific", "Behavioral", "Situational"). Make them specific to THIS role, not generic. Respond with ONLY a compact JSON array and nothing else:
[{"category":"<category>","question":"<question>"}]`;
    const raw =
      this.provider === 'claude'
        ? await this.callClaude(prompt)
        : await this.callGemini(prompt);
    return this.parseQuestions(raw);
  }

  private parseQuestions(raw: string): InterviewQuestion[] {
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(match ? match[0] : raw) as unknown[];
      if (!Array.isArray(arr)) return [];
      return arr
        .map((q) => {
          const o = q as { category?: unknown; question?: unknown };
          return {
            category: String(o.category ?? 'General').slice(0, 60),
            question: String(o.question ?? '').slice(0, 500),
          };
        })
        .filter((q) => q.question)
        .slice(0, 20);
    } catch {
      this.logger.warn(`Could not parse AI questions: ${raw.slice(0, 120)}`);
      return [];
    }
  }

  private buildRoleProfilePrompt(i: RoleProfileInput): string {
    return `You are an experienced HR business partner at DBL Group, a large Bangladeshi manufacturing conglomerate. Write a clear, professional job role profile for the position below, ready to publish to candidates.

Position: ${i.designation}
Department: ${i.department}
Unit / Factory: ${i.unitFactory}
Place of posting: ${i.placeOfPosting}
Number of posts: ${i.requiredPosts}
Employment nature: ${i.employmentNature ?? 'permanent'}
Hiring manager's brief / job description: ${i.jobDescription || '(none provided)'}
Required education & training: ${i.education}
Required experience: ${i.experience}
Other requirements: ${i.others?.trim() || '(none)'}

Write specifically for THIS role and unit — do not be generic. Respond with ONLY a compact JSON object and nothing else:
{"summary":"<2-3 sentence overview of the role and its purpose>","jobDescription":"<one well-written paragraph describing the role>","responsibilities":["<5 to 7 concrete responsibilities>"],"requirements":["<4 to 6 requirements covering education, experience and key skills>"]}`;
  }

  private parseRoleProfile(raw: string): RoleProfileResult {
    const toLines = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .map((x) => String(x).trim())
            .filter(Boolean)
            .slice(0, 10)
        : [];
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : raw) as {
        summary?: unknown;
        jobDescription?: unknown;
        responsibilities?: unknown;
        requirements?: unknown;
      };
      return {
        summary: String(obj.summary ?? '').trim(),
        jobDescription: String(obj.jobDescription ?? '').trim(),
        responsibilities: toLines(obj.responsibilities),
        requirements: toLines(obj.requirements),
      };
    } catch {
      this.logger.warn(
        `Could not parse AI role profile output: ${raw.slice(0, 120)}`,
      );
      return {
        summary: '',
        jobDescription: '',
        responsibilities: [],
        requirements: [],
      };
    }
  }

  private buildPrompt(i: GradeInput): string {
    return `You are an impartial examiner grading a candidate's exam answer.

Question: ${i.prompt}
Expected / model answer: ${
      i.modelAnswer?.trim() ||
      '(none provided — grade on correctness, relevance and completeness)'
    }
Maximum marks: ${i.maxMarks}

Candidate's answer:
"""${i.candidateAnswer}"""

Grade strictly and fairly. Respond with ONLY a compact JSON object and nothing else:
{"score": <integer between 0 and ${i.maxMarks}>, "feedback": "<one or two short sentences>"}`;
  }

  private async callGemini(text: string): Promise<string> {
    const model = this.config.get<string>('ai.gemini.model');
    const key = this.config.get<string>('ai.gemini.apiKey') ?? '';
    const res = await this.fetchJson<GeminiResp>(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
          },
        }),
      },
    );
    return res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  private async callClaude(text: string, maxTokens = 400): Promise<string> {
    const model = this.config.get<string>('ai.anthropic.model');
    const key = this.config.get<string>('ai.anthropic.apiKey') ?? '';
    const res = await this.fetchJson<ClaudeResp>(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: text }],
        }),
      },
    );
    return res.content?.[0]?.text ?? '';
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const r = await fetch(url, { ...init, signal: controller.signal });
      const json = (await r.json()) as T;
      if (!r.ok) {
        this.logger.warn(
          `AI provider error ${r.status}: ${JSON.stringify(json).slice(0, 200)}`,
        );
        throw new ServiceUnavailableException('AI grading request failed');
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(raw: string, maxMarks: number): GradeResult {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : raw) as {
        score?: unknown;
        feedback?: unknown;
      };
      const score = Math.max(
        0,
        Math.min(maxMarks, Math.round(Number(obj.score) || 0)),
      );
      const feedback = String(obj.feedback ?? '').slice(0, 500);
      return { score, feedback };
    } catch {
      this.logger.warn(
        `Could not parse AI grading output: ${raw.slice(0, 120)}`,
      );
      return { score: 0, feedback: '' };
    }
  }
}
