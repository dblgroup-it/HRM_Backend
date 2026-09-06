import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { MailService } from '../integrations/mail/mail.service';
import {
  FACILITY_KEYS,
  FACILITY_LABEL,
  type FacilityDecision,
} from '../requisition/requisition.service';
import { NotifyFacilityDto } from './dto/facility-provisioning.dto';

/** Which pool of employees to suggest for a facility's recipient picker. */
const RECIPIENT_KIND: Record<string, 'admin' | 'it'> = {
  laptopDesktop: 'it',
  transport: 'admin',
  dormitory: 'admin',
  seating: 'admin',
};

@Injectable()
export class FacilityProvisioningService {
  private readonly logger = new Logger(FacilityProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Confirmed + requested facilities for this candidate, with notification status (one or more recipients each). */
  async getStatus(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const notifs = await this.prisma.facilityNotification.findMany({
      where: { candidateId: cand.id },
      orderBy: { sentAt: 'desc' },
    });
    const byKey = new Map<string, typeof notifs>();
    for (const n of notifs) {
      const list = byKey.get(n.facilityKey) ?? [];
      list.push(n);
      byKey.set(n.facilityKey, list);
    }
    const facilities = (cand.requisition.facilities ?? {}) as unknown as Record<
      string,
      FacilityDecision
    >;

    const items = FACILITY_KEYS.filter(
      (key) => facilities[key]?.requested && facilities[key]?.status === 'confirmed',
    ).map((key) => {
      const recipients = byKey.get(key) ?? [];
      const confirmed = recipients.find((r) => r.confirmedAt);
      return {
        key,
        label: FACILITY_LABEL[key],
        kind: RECIPIENT_KIND[key],
        recipients: recipients.map((r) => ({
          recipientName: r.recipientName,
          recipientEmail: r.recipientEmail,
          sentAt: r.sentAt.toISOString(),
          confirmedAt: r.confirmedAt?.toISOString() ?? null,
          confirmNote: r.confirmNote,
        })),
        confirmedBy: confirmed?.recipientName ?? null,
        confirmedAt: confirmed?.confirmedAt?.toISOString() ?? null,
        confirmNote: confirmed?.confirmNote ?? null,
      };
    });

    return { items };
  }

  /** Suggested default recipients — senior Admin (or IT) staff in the candidate's unit. Not exclusive; HR can pick anyone via the general employee search. */
  async suggestRecipients(candidateId: string, key: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const kind = RECIPIENT_KIND[key];
    if (!kind) throw new BadRequestException('Unknown facility key');

    const deptFilter =
      kind === 'it'
        ? { OR: [{ department: { startsWith: 'IT', mode: 'insensitive' as const } }, { department: { contains: 'information technology', mode: 'insensitive' as const } }] }
        : { department: { contains: 'admin', mode: 'insensitive' as const } };

    const rows = await this.prisma.employee.findMany({
      where: { unitName: { equals: cand.requisition.unitFactory, mode: 'insensitive' }, ...deptFilter },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [{ grade: 'desc' }, { joiningDate: 'asc' }],
      take: 10,
    });

    return rows
      .filter((r) => r.user.email)
      .map((r) => ({
        userId: r.user.id,
        name: r.user.name,
        email: r.user.email as string,
        designation: r.designation,
        department: r.department,
      }));
  }

  /** Notify one or several chosen recipients (Admin or IT) to arrange one confirmed facility — any one confirming marks it arranged. */
  async notify(
    candidateId: string,
    key: string,
    dto: NotifyFacilityDto,
    actor: { id: string; name: string },
  ) {
    const cand = await this.requireCandidate(candidateId, actor.id);
    if (!FACILITY_KEYS.includes(key as (typeof FACILITY_KEYS)[number])) {
      throw new BadRequestException('Unknown facility key');
    }
    const facilities = (cand.requisition.facilities ?? {}) as unknown as Record<
      string,
      FacilityDecision
    >;
    const f = facilities[key];
    if (!f?.requested || f.status !== 'confirmed') {
      throw new BadRequestException(
        'This facility was not requested and confirmed — nothing to provision.',
      );
    }
    if (dto.recipients.length === 0) {
      throw new BadRequestException('Pick at least one recipient');
    }

    const frontendUrl = this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';

    for (const r of dto.recipients) {
      let recipientUserId = r.userId?.trim() || null;
      let recipientName = r.name?.trim() || '';
      let recipientEmail = r.email?.trim() || '';

      if (recipientUserId) {
        const user = await this.prisma.user.findUnique({
          where: { id: recipientUserId },
          select: { id: true, name: true, email: true },
        });
        if (!user) throw new NotFoundException('Selected recipient not found');
        if (!user.email) {
          throw new BadRequestException(`${user.name} has no email on file`);
        }
        recipientName = user.name;
        recipientEmail = user.email;
      } else {
        // Manual entry — still needs a User to attach the notification to;
        // fall back to the sending HR user's own account only for satisfying
        // the schema's not-null FK, the email itself goes to recipientEmail.
        if (!recipientName || !recipientEmail) {
          throw new BadRequestException(
            'Pick a recipient from the directory, or provide a name and email',
          );
        }
        recipientUserId = actor.id;
      }

      const token = crypto.randomBytes(24).toString('hex');
      const tokenExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

      await this.prisma.facilityNotification.create({
        data: {
          candidateId: cand.id,
          facilityKey: key,
          recipientUserId,
          recipientName,
          recipientEmail,
          token,
          tokenExpiresAt,
          sentById: actor.id,
        },
      });

      const confirmUrl = `${frontendUrl}/facility-provisioning/${token}`;
      try {
        await this.mail.send({
          to: recipientEmail,
          subject: `Please arrange ${FACILITY_LABEL[key]} — ${cand.name} | DBL Group`,
          html: this.emailHtml(
            `Dear ${recipientName || 'Colleague'},<br><br>
            <b>${cand.name}</b> has been selected for <b>${cand.requisition.designation}</b>
            (${cand.requisition.unitFactory}${cand.requisition.department ? ` — ${cand.requisition.department}` : ''})
            and will need <b>${FACILITY_LABEL[key]}</b> arranged before joining.<br><br>
            Once it's arranged, please confirm using the button below.`,
            { label: `Confirm ${FACILITY_LABEL[key]} arranged`, url: confirmUrl },
          ),
        });
      } catch (e) {
        this.logger.error(`Failed to send facility notification email: ${(e as Error).message}`);
      }
    }

    return this.getStatus(candidateId, actor.id);
  }

  // --- Public (token) ------------------------------------------------------

  async getByToken(token: string) {
    const n = await this.prisma.facilityNotification.findUnique({
      where: { token },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!n) throw new NotFoundException('This link is invalid or has been removed.');
    if (new Date() > n.tokenExpiresAt) {
      throw new BadRequestException('This link has expired.');
    }
    if (n.confirmedAt) {
      return { alreadyConfirmed: true, recipientName: n.recipientName };
    }
    return {
      alreadyConfirmed: false,
      recipientName: n.recipientName,
      facilityKey: n.facilityKey,
      facilityLabel: FACILITY_LABEL[n.facilityKey] ?? n.facilityKey,
      candidate: {
        name: n.candidate.name,
        designation: n.candidate.requisition.designation,
        unit: n.candidate.requisition.unitFactory,
        department: n.candidate.requisition.department,
        code: n.candidate.requisition.code,
      },
    };
  }

  async confirmByToken(token: string, note?: string) {
    const n = await this.prisma.facilityNotification.findUnique({
      where: { token },
      include: { candidate: { include: { requisition: true } } },
    });
    if (!n) throw new NotFoundException('Invalid link.');
    if (new Date() > n.tokenExpiresAt) throw new BadRequestException('This link has expired.');
    if (n.confirmedAt) return { ok: true, alreadyConfirmed: true };

    await this.prisma.facilityNotification.update({
      where: { id: n.id },
      data: { confirmedAt: new Date(), confirmNote: note ?? null },
    });

    try {
      await this.notifications.notify(n.sentById, {
        type: 'facility_provisioned',
        title: 'Facility arranged',
        message: `${n.recipientName} confirmed ${FACILITY_LABEL[n.facilityKey] ?? n.facilityKey} is arranged for ${n.candidate.name}.`,
        link: `/onboarding/manage/${n.candidateId}`,
      });
    } catch (e) {
      this.logger.error(`Failed to notify HR of facility confirmation: ${(e as Error).message}`);
    }

    return { ok: true, alreadyConfirmed: false };
  }

  // --- Helpers ---------------------------------------------------------------

  private async requireCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);
    return cand;
  }

  /**
   * Post-approval work is Corporate HR / CHRO / super — plus the Corporate
   * Recruiter assigned to this requisition. Takes the requisition (not just
   * its unit) so the assigned recruiter is always considered.
   */
  private async requireRecruitmentAccess(
    req: { unitFactory: string; recruiterId: string | null },
    userId: string,
  ) {
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'manage facility provisioning',
    );
  }

  private emailHtml(bodyHtml: string, cta?: { label: string; url: string }): string {
    const button = cta
      ? `<tr><td style="padding:8px 28px 28px"><a href="${cta.url}" style="display:inline-block;background:#1877c0;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:bold">${cta.label}</a></td></tr>
         <tr><td style="padding:0 28px 28px;font-size:12px;color:#94a3b8">Or paste this link into your browser:<br><span style="color:#64748b">${cta.url}</span></td></tr>`
      : '';
    return `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
          <tr><td style="background:#1877c0;padding:18px 28px;color:#fff;font-size:18px;font-weight:bold">DBL Group — HR</td></tr>
          <tr><td style="padding:28px 28px 16px;font-size:14px;line-height:1.7;color:#334155">${bodyHtml}</td></tr>
          ${button}
          <tr><td style="padding:18px 28px;background:#f8fafc;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0">This message was sent by DBL Group HR. Please do not share this link.</td></tr>
        </table>
      </td></tr></table>
    </body></html>`;
  }
}
