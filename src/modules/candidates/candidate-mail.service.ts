import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../integrations/mail/mail.service';
import { designationLabel } from '../requisition/requisition-inputs';
import {
  applicationReceivedEmail,
  referredCandidateEmail,
  referrerEmail,
  type VacancyFacts,
} from './recruitment-emails';
import { applicationId, referralId } from './reference-ids';
import { regretMail } from './regret-mail';

const VACANCY_SELECT = {
  designation: true,
  alternateDesignations: true,
  unitFactory: true,
  placeOfPosting: true,
} satisfies Prisma.RequisitionSelect;

type VacancyRow = Prisma.RequisitionGetPayload<{
  select: typeof VACANCY_SELECT;
}>;

function vacancy(req: VacancyRow): VacancyFacts {
  return {
    position: designationLabel(req.designation, req.alternateDesignations),
    businessUnit: req.unitFactory.trim(),
    location: req.placeOfPosting?.trim() || null,
  };
}

/**
 * The letters candidates and referrers get from Talent Acquisition, and the
 * links in them: the confirmation when somebody applies on the careers page,
 * the pair that goes out when an employee refers somebody, and the regret
 * letter's wording.
 *
 * Everything here is best-effort. A letter that cannot go is logged; it never
 * fails the application or the referral it is about.
 */
@Injectable()
export class CandidateMailService {
  private readonly logger = new Logger(CandidateMailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** The public site — the live one, or the dev server's own. */
  private siteUrl(): string {
    return this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';
  }

  careersUrl(): string {
    return `${this.siteUrl()}/careers`;
  }

  /** The status page, already looking up this applicant's applications. */
  statusUrl(email: string): string {
    return `${this.siteUrl()}/apply/status?email=${encodeURIComponent(email.trim())}`;
  }

  /** The regret letter for one candidate, addressed to them by name. */
  regret(cand: {
    name: string;
    requisition: {
      designation: string;
      alternateDesignations?: string[] | null;
    };
  }) {
    return regretMail({
      candidateName: cand.name,
      position: designationLabel(
        cand.requisition.designation,
        cand.requisition.alternateDesignations,
      ),
      careersUrl: this.careersUrl(),
    });
  }

  /** "We have your application" — to whoever just applied on the careers page. */
  async sendApplicationReceived(candidateId: string): Promise<void> {
    try {
      const cand = await this.prisma.candidate.findUnique({
        where: { id: candidateId },
        select: {
          name: true,
          email: true,
          applicationNo: true,
          createdAt: true,
          requisition: { select: VACANCY_SELECT },
        },
      });
      const to = cand?.email?.trim();
      if (!cand || !to || !this.mail.isConfigured()) return;
      const email = applicationReceivedEmail({
        ...vacancy(cand.requisition),
        candidateName: cand.name,
        applicationId: applicationId(cand.applicationNo, cand.createdAt),
        statusUrl: this.statusUrl(to),
        careersUrl: this.careersUrl(),
      });
      await this.mail.send({ to, ...email });
    } catch (err) {
      this.logger.warn(
        `Application confirmation not sent for candidate ${candidateId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Write to everyone a referral concerns: each referred candidate who has an
   * email address, then the employee who referred them, once, listing them all.
   *
   * Called once the CVs have been read — most referred CVs arrive with a name
   * only, and the address comes off the CV. A candidate whose CV carried none
   * is still listed to the referrer, by name.
   */
  async notifyReferral(id: string): Promise<void> {
    // Claimed before anything is sent: the queue and the sweep can both reach
    // the same referral, and a referrer thanked twice reads as a fault.
    const claimed = await this.prisma.candidateReferral.updateMany({
      where: { id, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    if (!claimed.count) return;

    const referral = await this.prisma.candidateReferral.findUnique({
      where: { id },
      select: {
        referenceNo: true,
        createdAt: true,
        referrerCode: true,
        referrerName: true,
        requisition: { select: VACANCY_SELECT },
        // Somebody removed straight after being sent in was a mistake, and is
        // neither written to nor listed.
        candidates: {
          where: { deletedAt: null },
          orderBy: { applicationNo: 'asc' },
          select: { id: true, name: true, email: true },
        },
      },
    });
    if (!referral?.candidates.length) return;
    if (!this.mail.isConfigured()) {
      this.logger.warn(
        `Referral ${referral.referenceNo}: email is not configured, nobody was written to.`,
      );
      return;
    }

    const facts = vacancy(referral.requisition);
    const careersUrl = this.careersUrl();

    for (const c of referral.candidates) {
      const to = c.email?.trim();
      if (!to) continue;
      try {
        await this.mail.send({
          to,
          ...referredCandidateEmail({
            ...facts,
            candidateName: c.name,
            referrerName: referral.referrerName,
            careersUrl,
          }),
        });
      } catch (err) {
        this.logger.warn(
          `Referral notice not sent to candidate ${c.id}: ${(err as Error).message}`,
        );
      }
    }

    const referrer = await this.prisma.user.findUnique({
      where: { employeeCode: referral.referrerCode },
      select: {
        name: true,
        email: true,
        status: true,
        emailNotifications: true,
      },
    });
    const to = referrer?.email?.trim();
    // Someone who has turned email off on their profile is not written to.
    if (
      !referrer ||
      !to ||
      referrer.status !== 'ACTIVE' ||
      !referrer.emailNotifications
    ) {
      this.logger.log(
        `Referral ${referral.referenceNo}: referrer ${referral.referrerCode} has no email to write to, or has email turned off.`,
      );
      return;
    }
    try {
      await this.mail.send({
        to,
        ...referrerEmail({
          ...facts,
          referrerName: referrer.name || referral.referrerName,
          referralId: referralId(referral.referenceNo, referral.createdAt),
          candidates: referral.candidates.map((c) => ({
            name: c.name,
            email: c.email,
          })),
          careersUrl,
        }),
      });
    } catch (err) {
      this.logger.warn(
        `Referral confirmation not sent to referrer ${referral.referrerCode}: ${(err as Error).message}`,
      );
    }
  }
}
