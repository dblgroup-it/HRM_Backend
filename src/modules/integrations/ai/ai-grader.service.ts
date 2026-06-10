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
      input.mimeType.startsWith('image/') || input.mimeType === 'application/pdf';
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
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
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
        for (const [k, v] of Object.entries(obj.fields as Record<string, unknown>)) {
          if (v != null && String(v).trim()) fields[k] = String(v).slice(0, 300);
        }
      }
      return {
        summary: String(obj.summary ?? '').slice(0, 600),
        fields,
      };
    } catch {
      this.logger.warn(`Could not parse AI extraction output: ${raw.slice(0, 120)}`);
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
      arr && arr.length ? arr.map((x) => `- ${x}`).join('\n') : '(none specified)';
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
      this.logger.warn(`Could not parse AI screening output: ${raw.slice(0, 120)}`);
      return { score: 0, summary: '', email: null, phone: null };
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
        ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 10)
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
      return { summary: '', jobDescription: '', responsibilities: [], requirements: [] };
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
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
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
      this.logger.warn(`Could not parse AI grading output: ${raw.slice(0, 120)}`);
      return { score: 0, feedback: '' };
    }
  }
}
