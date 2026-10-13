import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ItAccountRequest } from '@prisma/client';

import {
  generateActionToken,
  hashActionToken,
} from '../../common/crypto/action-token';
import { isEmailAddress, parseEmailList } from '../../common/util/email-list';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../integrations/mail/mail.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import {
  SettingsService,
  type ItRequestConfig,
} from '../settings/settings.service';
import {
  CompleteItRequestDto,
  SendItRequestDto,
} from './dto/it-account-request.dto';
import {
  defaultItPurpose,
  renderItCompletion,
  renderItRequest,
  type ItLeaver,
  type ItLeaverDone,
  type ItRequestMail,
} from './it-account-request-email';

/**
 * How long IT's confirmation link works. Generous on purpose: accounts are
 * often made close to the joining date, weeks after the request.
 */
export const IT_REQUEST_LINK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Offered in the dialog beside whatever Integrations names as the default. */
const PLATFORMS = ['Google', 'Microsoft 365'];

const withCandidate = {
  candidate: {
    include: {
      requisition: {
        include: {
          replacements: { orderBy: { orderIndex: 'asc' } },
        },
      },
    },
  },
} satisfies Prisma.OnboardingInclude;

type OnboardingCtx = Prisma.OnboardingGetPayload<{
  include: typeof withCandidate & { itRequest: true };
}>;

type Requester = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  employee: { designation: string | null; department: string | null } | null;
};

/** JSON columns read back defensively — they were written by this code, but are still JSON. */
function leaversOf(value: Prisma.JsonValue | null | undefined): ItLeaver[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Prisma.JsonObject => Boolean(v) && typeof v === 'object')
    .map((v) => ({
      name: String(v.name ?? ''),
      code: v.code ? String(v.code) : null,
      email: String(v.email ?? ''),
      reason: v.reason ? String(v.reason) : null,
    }));
}

/** Someone copied on the request — a directory pick, with the address the server looked up. */
export type ItCcPerson = {
  code: string;
  name: string;
  designation: string | null;
  /** Null when the directory has no address for them; sending is refused until they are removed. */
  email: string | null;
};

function ccOf(value: Prisma.JsonValue | null | undefined): ItCcPerson[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Prisma.JsonObject => Boolean(v) && typeof v === 'object')
    .map((v) => ({
      code: String(v.code ?? ''),
      name: String(v.name ?? ''),
      designation: v.designation ? String(v.designation) : null,
      email: v.email ? String(v.email) : null,
    }));
}

function doneOf(value: Prisma.JsonValue | null | undefined): ItLeaverDone[] {
  if (!Array.isArray(value)) return [];
  return leaversOf(value).map((l, i) => ({
    ...l,
    deleted: Boolean((value[i] as Prisma.JsonObject | null)?.deleted),
  }));
}

/** What the onboarding page shows about the request. Pure, so OnboardingService can use it without injecting this service. */
export function itRequestView(r: ItAccountRequest | null | undefined) {
  if (!r) return null;
  return {
    id: r.id,
    sentTo: r.sentTo,
    subject: r.subject,
    sentAt: r.sentAt.toISOString(),
    lastSentAt: r.lastSentAt.toISOString(),
    sendCount: r.sendCount,
    sentByName: r.sentByName,
    preferredEmail: r.preferredEmail,
    platform: r.platform,
    deletions: leaversOf(r.deletions),
    cc: ccOf(r.cc),
    expiresAt: r.tokenExpiresAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    completedByName: r.completedByName,
    createdEmail: r.createdEmail,
    deletionsDone: r.deletionsDone ? doneOf(r.deletionsDone) : null,
    completionNote: r.completionNote,
    confirmationSentAt: r.confirmationSentAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    closedReason: r.closedReason,
  };
}

/**
 * "Notify IT" — onboarding's last step.
 *
 * HR sends IT a request for the new hire's work email in DBL's own format
 * (and, for a replacement, asks for the leaver's account to be deleted). IT
 * confirms from the link in that email; their answer records the address,
 * completes the onboarding, and mails the requester the "completed" reply.
 */
@Injectable()
export class ItAccountRequestService {
  private readonly logger = new Logger(ItAccountRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  // --- HR -------------------------------------------------------------------

  /** Everything the dialog starts from: the hire, the leavers, last time's answers. */
  async draft(candidateId: string, userId: string) {
    const ob = await this.load(candidateId, userId);
    await this.assertReady(ob);
    const [config, me, leavers, deliverable] = await Promise.all([
      this.settings.getItRequestConfig(),
      this.requester(userId),
      this.leavers(ob),
      this.mail.canDeliver(),
    ]);
    const req = ob.candidate.requisition;
    const designation = ob.fixedDesignation ?? req.designation;
    const prev = ob.itRequest;
    const asked = prev ? leaversOf(prev.deletions) : [];
    const askedFor = (l: ItLeaver) =>
      asked.find(
        (a) =>
          (Boolean(a.code) && a.code === l.code) ||
          a.name.trim().toLowerCase() === l.name.trim().toLowerCase(),
      );

    return {
      recipients: config.recipients,
      salutation: config.salutation,
      // Reply-To only — nobody is copied unless HR adds them.
      requesterEmail: me.email,
      deliverable,
      platforms: [...new Set([config.platform, ...PLATFORMS])],
      employee: {
        name: ob.candidate.name,
        employeeId: ob.candidate.employeeId,
        designation,
        department: req.department,
        unit: req.unitFactory,
        lineOfBusiness: req.lineOfBusiness,
        joiningDate:
          (ob.offerJoiningTentative ?? ob.offerJoiningDate)?.toISOString() ??
          null,
      },
      preferredEmail: prev?.preferredEmail ?? '',
      platform: prev?.platform ?? config.platform,
      purpose: prev?.purpose ?? defaultItPurpose(designation, req.department),
      deletions: leavers.map((l) => {
        // A re-send starts from what was asked last time, including an
        // address HR typed because the directory had none.
        const before = askedFor(l);
        return {
          ...l,
          email: l.email || before?.email || '',
          include: prev ? Boolean(before) : l.include,
        };
      }),
      // A re-send copies the same people; a first request copies nobody.
      cc: prev ? ccOf(prev.cc) : [],
      previous: itRequestView(prev),
    };
  }

  /** The email exactly as it would go, for the dialog's preview pane. */
  async preview(candidateId: string, dto: SendItRequestDto, userId: string) {
    const ob = await this.load(candidateId, userId);
    const [config, me] = await Promise.all([
      this.settings.getItRequestConfig(),
      this.requester(userId),
    ]);
    const cc = await this.resolveCc(dto.ccCodes, config.recipients);
    const mail = renderItRequest(this.content(ob, dto, config, me, null));
    return {
      subject: mail.subject,
      html: mail.html,
      to: config.recipients,
      cc,
    };
  }

  async send(
    candidateId: string,
    dto: SendItRequestDto,
    actor: { id: string },
  ) {
    const ob = await this.load(candidateId, actor.id);
    await this.assertReady(ob);
    this.validate(dto);
    if (!(await this.mail.canDeliver())) {
      throw new BadRequestException(
        'Outgoing email is switched off, so IT would not receive the request. Turn on the master email switch on Integrations, or record the work email by hand.',
      );
    }
    const [config, me] = await Promise.all([
      this.settings.getItRequestConfig(),
      this.requester(actor.id),
    ]);
    const cc = await this.resolveCc(dto.ccCodes, config.recipients);
    const noAddress = cc.find((c) => !c.email);
    if (noAddress) {
      throw new BadRequestException(
        `${noAddress.name} has no email address in the employee directory — remove them from Cc.`,
      );
    }

    const raw = generateActionToken();
    const frontendUrl =
      this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';
    const content = this.content(
      ob,
      dto,
      config,
      me,
      `${frontendUrl}/it-request/${raw}`,
    );
    const mail = renderItRequest(content);
    const now = new Date();
    const fields = {
      sentTo: config.recipients.join(', '),
      subject: mail.subject,
      employeeName: content.employeeName,
      preferredEmail: content.preferredEmail ?? null,
      platform: content.platform,
      purpose: content.purpose ?? null,
      deletions: content.deletions as unknown as Prisma.InputJsonValue,
      cc: cc as unknown as Prisma.InputJsonValue,
      // The copy kept is what was sent minus the secret: the raw link would
      // make the hashed token pointless to anyone reading the database.
      bodyText: mail.text.split(raw).join('…'),
      messageId: null,
      tokenHash: hashActionToken(raw),
      tokenExpiresAt: new Date(now.getTime() + IT_REQUEST_LINK_DAYS * DAY_MS),
      sentById: me.id,
      sentByName: me.name,
      lastSentAt: now,
      closedAt: null,
      closedReason: null,
    };

    // Saved before it is mailed, so the link works the moment it lands.
    const prev = ob.itRequest;
    const row = prev
      ? await this.prisma.itAccountRequest.update({
          where: { id: prev.id },
          data: { ...fields, sendCount: { increment: 1 } },
        })
      : await this.prisma.itAccountRequest.create({
          data: { ...fields, onboardingId: ob.id, sentAt: now },
        });

    let messageId: string;
    try {
      ({ messageId } = await this.mail.send({
        to: fields.sentTo,
        cc: cc.map((c) => c.email).join(', ') || undefined,
        // Should IT answer by email anyway, it reaches the person who asked.
        replyTo: me.email ?? undefined,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }));
    } catch (err) {
      // The link inside a mail that never left must not be the live one.
      await this.undo(row.id, prev);
      this.logger.error(
        `IT request for ${ob.candidate.name} not sent: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'The request could not be sent to IT. Please try again in a moment.',
      );
    }

    const saved = await this.prisma.itAccountRequest.update({
      where: { id: row.id },
      // 'sandbox' / 'suppressed' are not real Message-IDs to reply under.
      data: { messageId: messageId.includes('@') ? messageId : null },
    });
    this.notifications.broadcastChange(
      'candidate',
      ob.candidate.requisitionId,
      { action: 'it_requested' },
    );
    return { request: itRequestView(saved) };
  }

  // --- IT (public, by link) ---------------------------------------------------

  async getByToken(token: string) {
    const row = await this.findByToken(token);
    const ob = row.onboarding;
    const req = ob.candidate.requisition;
    const config = await this.settings.getItRequestConfig();
    return {
      state: row.completedAt
        ? 'completed'
        : row.closedAt
          ? 'closed'
          : row.tokenExpiresAt.getTime() < Date.now()
            ? 'expired'
            : 'open',
      salutation: config.salutation,
      requesterName: row.sentByName,
      sentAt: row.lastSentAt.toISOString(),
      expiresAt: row.tokenExpiresAt.toISOString(),
      employee: {
        name: row.employeeName,
        employeeId: ob.candidate.employeeId,
        designation: ob.fixedDesignation ?? req.designation,
        department: req.department,
        unit: req.unitFactory,
        joiningDate:
          (ob.offerJoiningTentative ?? ob.offerJoiningDate)?.toISOString() ??
          null,
      },
      preferredEmail: row.preferredEmail,
      platform: row.platform,
      purpose: row.purpose,
      deletions: leaversOf(row.deletions),
      completed: row.completedAt
        ? {
            at: row.completedAt.toISOString(),
            byName: row.completedByName,
            createdEmail: row.createdEmail,
            deletions: doneOf(row.deletionsDone),
          }
        : null,
      closedReason: row.closedReason,
    };
  }

  async completeByToken(token: string, dto: CompleteItRequestDto) {
    const createdEmail = dto.createdEmail.trim();
    if (!isEmailAddress(createdEmail)) {
      throw new BadRequestException('Enter the email address you created.');
    }
    const by = dto.completedByName.trim();
    if (by.length < 2) {
      throw new BadRequestException(
        'Enter your name — it signs the reply HR receives.',
      );
    }

    const row = await this.findByToken(token);
    if (row.completedAt) return { ok: true, alreadyCompleted: true };
    if (row.closedAt) {
      throw new BadRequestException(
        `HR has already closed this request${row.closedReason ? ` (${row.closedReason})` : ''}. Nothing more is needed.`,
      );
    }
    if (row.tokenExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException(
        'This link has expired. Ask HR to send the request again.',
      );
    }

    const deletedSet = new Set(
      (dto.deleted ?? []).map((e) => e.trim().toLowerCase()),
    );
    const done: ItLeaverDone[] = leaversOf(row.deletions).map((l) => ({
      ...l,
      deleted: deletedSet.has(l.email.toLowerCase()),
    }));
    const note = dto.note?.trim() || null;
    const now = new Date();

    // One answer only, however many times the button is pressed.
    const claimed = await this.prisma.itAccountRequest.updateMany({
      where: { id: row.id, completedAt: null, closedAt: null },
      data: {
        completedAt: now,
        completedByName: by,
        createdEmail,
        deletionsDone: done as unknown as Prisma.InputJsonValue,
        completionNote: note,
      },
    });
    if (!claimed.count) return { ok: true, alreadyCompleted: true };

    // IT's address is the work email, and this is what completes onboarding —
    // unless HR already finished it by hand, which stays as recorded.
    const ob = row.onboarding;
    if (!ob.itNotifiedAt) {
      await this.prisma.onboarding.update({
        where: { id: ob.id },
        data: { itEmail: createdEmail, itNotifiedAt: now, status: 'onboarded' },
      });
    } else if (!ob.itEmail) {
      await this.prisma.onboarding.update({
        where: { id: ob.id },
        data: { itEmail: createdEmail },
      });
    }

    await this.sendCompletion(row, createdEmail, done, note, by);

    const req = ob.candidate.requisition;
    const link = `/onboarding/manage/${ob.candidateId}`;
    const message = `${by} created ${createdEmail} for ${row.employeeName}. Onboarding is complete.`;
    try {
      if (row.sentById) {
        // They have the reply in their inbox already; no second email.
        await this.notifications.notify(row.sentById, {
          type: 'it_account_created',
          title: 'Work email created',
          message,
          link,
          skipEmail: true,
        });
      }
      const others = (
        await this.permissions.recruitmentRecipients(
          req.unitFactory,
          req.recruiterId,
          { userId: req.coverRecruiterId, until: req.coverUntil },
        )
      ).filter((id) => id !== row.sentById);
      await this.notifications.notifyMany(others, {
        type: 'it_account_created',
        title: 'Work email created',
        message,
        link,
      });
    } catch (err) {
      this.logger.warn(
        `Could not notify about ${row.employeeName}'s work email: ${(err as Error).message}`,
      );
    }
    this.notifications.broadcastChange('candidate', req.id, {
      action: 'it_completed',
    });
    return { ok: true, alreadyCompleted: false };
  }

  // --- helpers ------------------------------------------------------------------

  private async load(
    candidateId: string,
    userId: string,
  ): Promise<OnboardingCtx> {
    const ob = await this.prisma.onboarding.findUnique({
      where: { candidateId },
      include: { ...withCandidate, itRequest: true },
    });
    if (!ob) {
      throw new NotFoundException(
        'Onboarding has not started for this candidate',
      );
    }
    const req = ob.candidate.requisition;
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'ask IT for a work email',
      { userId: req.coverRecruiterId, until: req.coverUntil },
    );
    return ob;
  }

  /** The same gate as completing onboarding by hand. */
  private async assertReady(ob: OnboardingCtx): Promise<void> {
    if (ob.itNotifiedAt) {
      throw new BadRequestException(
        'Onboarding is already complete — the work email is recorded.',
      );
    }
    if (!ob.hrVerifiedAt) {
      throw new BadRequestException(
        'Complete HR final verification before notifying IT',
      );
    }
    const board = await this.prisma.boardApproval.findFirst({
      where: { candidateId: ob.candidateId, status: 'approved' },
      select: { id: true },
    });
    if (!board) {
      throw new BadRequestException(
        'Board Approval is required before onboarding can be completed',
      );
    }
  }

  private validate(dto: SendItRequestDto): void {
    const preferred = dto.preferredEmail?.trim();
    if (preferred && !isEmailAddress(preferred)) {
      throw new BadRequestException(
        `The preferred address is not an email address: ${preferred}`,
      );
    }
    for (const d of dto.deletions ?? []) {
      if (!d.name?.trim()) {
        throw new BadRequestException('Every account to delete needs a name.');
      }
      if (!isEmailAddress(d.email)) {
        throw new BadRequestException(
          `Enter ${d.name.trim()}'s email address, or leave their account out.`,
        );
      }
    }
  }

  /**
   * The people HR chose to copy, looked up by employee code.
   *
   * In the order picked, each once, and never an address the request is
   * already going to. A code the directory does not know comes back with no
   * address, so the dialog can say so and sending can refuse it.
   */
  private async resolveCc(
    codes: string[] | undefined,
    recipients: string[],
  ): Promise<ItCcPerson[]> {
    const wanted = [
      ...new Set((codes ?? []).map((c) => c.trim()).filter(Boolean)),
    ];
    if (!wanted.length) return [];
    const users = await this.prisma.user.findMany({
      where: { employeeCode: { in: wanted } },
      select: {
        employeeCode: true,
        name: true,
        email: true,
        employee: { select: { designation: true } },
      },
    });
    const going = new Set(recipients.map((r) => r.trim().toLowerCase()));
    const out: ItCcPerson[] = [];
    for (const code of wanted) {
      const u = users.find((x) => x.employeeCode === code);
      const email = u?.email?.trim() || null;
      const key = email?.toLowerCase();
      if (
        key &&
        (going.has(key) || out.some((o) => o.email?.toLowerCase() === key))
      ) {
        continue;
      }
      out.push({
        code,
        name: u?.name ?? code,
        designation: u?.employee?.designation ?? null,
        email: email && isEmailAddress(email) ? email : null,
      });
    }
    return out;
  }

  private async requester(userId: string): Promise<Requester> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        employee: { select: { designation: true, department: true } },
      },
    });
    if (!me) throw new NotFoundException('User not found');
    return me;
  }

  /**
   * The people this hire replaces, with their work email from the directory.
   *
   * Only a replacement has them. Ticked by default when the address is known
   * — except a transfer, who is still with the group and still needs it.
   */
  private async leavers(
    ob: OnboardingCtx,
  ): Promise<(ItLeaver & { include: boolean; found: boolean })[]> {
    const req = ob.candidate.requisition;
    if (req.requirementType !== 'EXISTING') return [];
    const rows = req.replacements.length
      ? req.replacements.map((r) => ({
          name: r.employeeName,
          code: r.employeeCode,
          reason: r.separationReason,
        }))
      : req.replaceOfName
        ? [
            {
              name: req.replaceOfName,
              code: req.replaceOfEmployeeCode,
              reason: req.separationReason,
            },
          ]
        : [];
    const codes = rows
      .map((r) => r.code?.trim())
      .filter((c): c is string => Boolean(c));
    const users = codes.length
      ? await this.prisma.user.findMany({
          where: { employeeCode: { in: codes } },
          select: { employeeCode: true, email: true },
        })
      : [];
    return rows.map((r) => {
      const email =
        users.find((u) => u.employeeCode === r.code?.trim())?.email?.trim() ??
        '';
      return {
        name: r.name,
        code: r.code?.trim() || null,
        email,
        reason: r.reason,
        found: Boolean(email),
        include: Boolean(email) && !/transfer/i.test(r.reason ?? ''),
      };
    });
  }

  private content(
    ob: OnboardingCtx,
    dto: SendItRequestDto,
    config: ItRequestConfig,
    me: Requester,
    confirmUrl: string | null,
  ): ItRequestMail {
    const req = ob.candidate.requisition;
    return {
      salutation: config.salutation,
      unit: req.unitFactory,
      lineOfBusiness: req.lineOfBusiness,
      employeeName: ob.candidate.name,
      employeeId: ob.candidate.employeeId,
      designation: ob.fixedDesignation ?? req.designation,
      department: req.department,
      preferredEmail: dto.preferredEmail?.trim() || null,
      platform: dto.platform?.trim() || config.platform,
      joiningDate: ob.offerJoiningTentative ?? ob.offerJoiningDate ?? null,
      purpose: dto.purpose?.trim() || null,
      deletions: (dto.deletions ?? []).map((d) => ({
        name: d.name.trim(),
        code: d.code?.trim() || null,
        email: d.email.trim(),
        reason: d.reason?.trim() || null,
      })),
      requester: {
        name: me.name,
        designation: me.employee?.designation,
        department: me.employee?.department,
        phone: me.phone,
      },
      confirmUrl,
    };
  }

  /** Put a request back the way it was before a send that failed. */
  private async undo(id: string, prev: ItAccountRequest | null): Promise<void> {
    try {
      if (!prev) {
        await this.prisma.itAccountRequest.delete({ where: { id } });
        return;
      }
      await this.prisma.itAccountRequest.update({
        where: { id },
        data: {
          sentTo: prev.sentTo,
          subject: prev.subject,
          employeeName: prev.employeeName,
          preferredEmail: prev.preferredEmail,
          platform: prev.platform,
          purpose: prev.purpose,
          deletions: prev.deletions as Prisma.InputJsonValue,
          cc: prev.cc as Prisma.InputJsonValue,
          bodyText: prev.bodyText,
          messageId: prev.messageId,
          tokenHash: prev.tokenHash,
          tokenExpiresAt: prev.tokenExpiresAt,
          sentById: prev.sentById,
          sentByName: prev.sentByName,
          lastSentAt: prev.lastSentAt,
          sendCount: prev.sendCount,
          closedAt: prev.closedAt,
          closedReason: prev.closedReason,
        },
      });
    } catch (err) {
      this.logger.error(
        `Could not restore IT request ${id}: ${(err as Error).message}`,
      );
    }
  }

  private async findByToken(token: string) {
    const row = await this.prisma.itAccountRequest.findUnique({
      where: { tokenHash: hashActionToken(token) },
      include: {
        onboarding: { include: withCandidate },
        sentBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!row) {
      throw new NotFoundException(
        'This link is not valid. It may have been replaced by a newer request from HR.',
      );
    }
    return row;
  }

  /** The "completed" reply, in DBL's format, to whoever asked — IT copied. */
  private async sendCompletion(
    row: Awaited<ReturnType<ItAccountRequestService['findByToken']>>,
    createdEmail: string,
    done: ItLeaverDone[],
    note: string | null,
    by: string,
  ): Promise<void> {
    const to = row.sentBy?.email?.trim();
    if (!to) {
      this.logger.warn(
        `No email for the requester of ${row.employeeName}'s IT request — reply not sent`,
      );
      return;
    }
    const reply = renderItCompletion({
      requesterName: row.sentBy?.name ?? row.sentByName,
      requestSubject: row.subject,
      employeeName: row.employeeName,
      createdEmail,
      deletions: done,
      note,
      completedByName: by,
    });
    // Reply-all: IT, and whoever HR copied on the request.
    const cc = parseEmailList(
      [row.sentTo, ...ccOf(row.cc).map((c) => c.email ?? '')].join(', '),
    ).valid.filter((e) => e.toLowerCase() !== to.toLowerCase());
    try {
      await this.mail.send({
        to,
        cc: cc.join(', ') || undefined,
        subject: reply.subject,
        text: reply.text,
        html: reply.html,
        inReplyTo: row.messageId ?? undefined,
      });
      await this.prisma.itAccountRequest.update({
        where: { id: row.id },
        data: { confirmationSentAt: new Date() },
      });
    } catch (err) {
      this.logger.error(
        `IT completion reply for ${row.employeeName} not sent: ${(err as Error).message}`,
      );
    }
  }
}
