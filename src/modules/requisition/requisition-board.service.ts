import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../integrations/mail/mail.service';
import {
  generateActionToken,
  hashActionToken,
} from '../../common/crypto/action-token';
import { RequisitionService, RequisitionFull } from './requisition.service';

/** How long a board member's emailed link stays usable. */
const VOTE_TTL_DAYS = 14;

/**
 * The board, after the CHRO.
 *
 * On the CHRO's step the CHRO may, instead of deciding alone, send the
 * requisition to the board: they pick one or more members of a board group,
 * a BOARD step is appended to the chain, and each member is emailed a link
 * to approve or reject it. The first answer decides the step — the rule the
 * candidate approval sheets already use — and the requisition then moves on
 * exactly as an in-app decision would (`RequisitionService.finishDecision`).
 */
@Injectable()
export class RequisitionBoardService {
  private readonly logger = new Logger(RequisitionBoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requisitions: RequisitionService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Board groups and their members, for the CHRO choosing who votes. */
  async boardMembers(id: string, userId: string) {
    const req = await this.requisitions.loadForBoard(id, userId);
    await this.requireChroStep(req, userId);
    const groups = await this.prisma.boardGroup.findMany({
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, status: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    return groups
      .map((g) => ({
        id: g.id,
        name: g.name,
        members: g.members
          .filter((m) => m.user.status === 'ACTIVE')
          .map((m) => ({
            id: m.user.id,
            name: m.user.name,
            hasEmail: Boolean(m.user.email),
          })),
      }))
      .filter((g) => g.members.length > 0);
  }

  async sendToBoard(
    id: string,
    memberIds: string[],
    note: string,
    actor: { id: string; name: string },
  ) {
    const req = await this.requisitions.loadForBoard(id, actor.id);
    const current = await this.requireChroStep(req, actor.id);

    const ids = [...new Set(memberIds)];
    if (ids.length === 0) {
      throw new BadRequestException('Choose at least one board member.');
    }
    // Only people who are actually on a board, and who can receive the mail.
    const onBoard = await this.prisma.boardGroupMember.findMany({
      where: { userId: { in: ids } },
      select: { userId: true },
    });
    const boardIds = new Set(onBoard.map((m) => m.userId));
    const members = await this.prisma.user.findMany({
      where: { id: { in: ids.filter((i) => boardIds.has(i)) }, status: 'ACTIVE' },
      select: { id: true, name: true, email: true },
    });
    if (members.length !== ids.length) {
      throw new BadRequestException(
        'Choose board members from the board groups.',
      );
    }
    const noEmail = members.filter((m) => !m.email);
    if (noEmail.length) {
      throw new BadRequestException(
        `${noEmail.map((m) => m.name).join(', ')} ${noEmail.length === 1 ? 'has' : 'have'} no email address, so cannot receive the approval link.`,
      );
    }

    const names = members.map((m) => m.name).join(', ');
    const step = await this.prisma.$transaction(async (tx) => {
      // The same claim `act` makes: exactly one decision per step.
      const claimed = await tx.approvalStep.updateMany({
        where: { id: current.id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          assignee: actor.name,
          note,
          actedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException(
          'This sign-off has already been actioned — reload to see its current state.',
        );
      }
      await tx.requisitionActivity.create({
        data: {
          requisitionId: id,
          actor: actor.name,
          action: 'ESCALATED',
          note: `Sent to the Board (${names})${note ? ` — ${note}` : ''}`,
        },
      });
      return tx.approvalStep.create({
        data: {
          requisitionId: id,
          orderIndex: req.approvalSteps.length,
          role: 'BOARD',
          title: 'Board',
          subtitle: 'Board approval by email',
          assignee: names.slice(0, 150),
          status: 'PENDING',
        },
      });
    });

    const expiresAt = new Date(Date.now() + VOTE_TTL_DAYS * 86_400_000);
    const base =
      this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';
    for (const m of members) {
      const token = generateActionToken();
      await this.prisma.requisitionBoardVote.create({
        data: {
          requisitionId: id,
          stepId: step.id,
          userId: m.id,
          // Only the hash is kept; the raw token lives in the email alone.
          tokenHash: hashActionToken(token),
          tokenExpiresAt: expiresAt,
        },
      });
      try {
        await this.mail.send({
          to: m.email!,
          subject: `Board approval needed — ${req.code} · ${req.designation}`,
          html: boardEmail(
            m.name,
            req,
            actor.name,
            note,
            `${base}/requisition-board/${token}`,
          ),
        });
      } catch (err) {
        this.logger.error(
          `Board approval email to ${m.email} failed: ${(err as Error).message}`,
        );
      }
    }

    return this.requisitions.finishDecision(id, 'escalate', actor.name);
  }

  /** What the emailed link shows. */
  async voteInfo(token: string) {
    const vote = await this.findVote(token);
    const req = vote.requisition;
    return {
      voter: vote.user.name,
      status: vote.status,
      expired: vote.tokenExpiresAt < new Date(),
      // Somebody else on the board may already have decided it.
      decided:
        vote.step.status === 'PENDING'
          ? null
          : {
              outcome: vote.step.status === 'APPROVED' ? 'approved' : 'rejected',
              by: vote.step.assignee,
            },
      requisition: {
        code: req.code,
        designation: req.designation,
        unit: req.unitFactory,
        department: req.department,
        section: req.section,
        requiredPosts: req.requiredPosts,
        requirementType: req.requirementType === 'NEW' ? 'new' : 'replacement',
        priority: req.priority.toLowerCase(),
        employmentNature: req.employmentNature.toLowerCase(),
        placeOfPosting: req.placeOfPosting,
        neededDate: req.neededDate?.toISOString() ?? null,
        raisedBy: req.raisedBy,
        jobDescription: req.jobDescription,
        education: req.education,
        experience: req.experience,
        chain: req.approvalSteps.map((s) => ({
          title: s.title,
          assignee: s.assignee,
          status: s.status.toLowerCase(),
          note: s.note,
          actedAt: s.actedAt?.toISOString() ?? null,
        })),
      },
    };
  }

  async vote(token: string, decision: 'approved' | 'rejected', note?: string) {
    const vote = await this.findVote(token);
    if (vote.tokenExpiresAt < new Date()) {
      throw new BadRequestException('This approval link has expired.');
    }
    if (vote.status !== 'pending') return { ok: true, alreadyVoted: true };
    if (vote.step.status !== 'PENDING') {
      return { ok: true, alreadyDecided: true };
    }
    const reason = note?.trim() ?? '';
    if (decision === 'rejected' && reason.length < 2) {
      throw new BadRequestException('Give a reason when rejecting.');
    }

    // One answer per link, even if it is submitted twice at once.
    const mine = await this.prisma.requisitionBoardVote.updateMany({
      where: { id: vote.id, status: 'pending' },
      data: { status: decision, notes: reason || null, respondedAt: new Date() },
    });
    if (mine.count !== 1) return { ok: true, alreadyVoted: true };

    const decidedHere = await this.prisma.$transaction(async (tx) => {
      // First answer decides: claim the step; a second member arriving a
      // moment later finds it decided.
      const step = await tx.approvalStep.updateMany({
        where: { id: vote.stepId, status: 'PENDING' },
        data: {
          status: decision === 'approved' ? 'APPROVED' : 'REJECTED',
          assignee: vote.user.name,
          note: reason,
          actedAt: new Date(),
        },
      });
      if (step.count !== 1) return false;
      await tx.requisition.update({
        where: { id: vote.requisitionId },
        data: { status: decision === 'approved' ? 'APPROVED' : 'REJECTED' },
      });
      await tx.requisitionActivity.create({
        data: {
          requisitionId: vote.requisitionId,
          actor: `${vote.user.name} (Board)`,
          action: decision === 'approved' ? 'APPROVED' : 'REJECTED',
          note: reason,
        },
      });
      return true;
    });
    if (!decidedHere) return { ok: true, alreadyDecided: true };

    await this.requisitions.finishDecision(
      vote.requisitionId,
      decision,
      vote.user.name,
    );
    return { ok: true, decision };
  }

  /** The pending CHRO step this user may act on, or a refusal. */
  private async requireChroStep(req: RequisitionFull, userId: string) {
    const steps = req.approvalSteps;
    if (steps.some((s) => s.status === 'INFO_REQUESTED')) {
      throw new BadRequestException(
        `${req.code} is back with ${req.raisedBy || 'the requisitioner'} for clarification.`,
      );
    }
    const idx = steps.findIndex((s) => s.status === 'PENDING');
    const current = idx >= 0 ? steps[idx] : null;
    if (!current || current.role !== 'CHRO' || idx !== steps.length - 1) {
      throw new BadRequestException(
        'Only the CHRO step can be sent to the board.',
      );
    }
    if (!(await this.requisitions.mayActOnStep(current, req.unitFactory, userId))) {
      throw new ForbiddenException(
        'Only the CHRO can send this requisition to the board.',
      );
    }
    return current;
  }

  private async findVote(token: string) {
    const vote = await this.prisma.requisitionBoardVote.findUnique({
      where: { tokenHash: hashActionToken(token) },
      include: {
        user: { select: { id: true, name: true } },
        step: true,
        requisition: {
          include: { approvalSteps: { orderBy: { orderIndex: 'asc' } } },
        },
      },
    });
    if (!vote) throw new NotFoundException('This approval link is not valid.');
    return vote;
  }
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}

function boardEmail(
  member: string,
  req: RequisitionFull,
  chro: string,
  note: string,
  link: string,
): string {
  const row = (k: string, v: string | number | null | undefined) =>
    v === null || v === undefined || v === ''
      ? ''
      : `<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:13px">${k}</td><td style="padding:4px 0;color:#0f172a;font-size:13px">${esc(String(v))}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;color:#0f172a;max-width:560px">
    <p style="font-size:14px">Dear ${esc(member)},</p>
    <p style="font-size:14px;line-height:1.6">${esc(chro)} (CHRO) has sent this manpower requisition to the board for approval.</p>
    ${note ? `<p style="font-size:13px;color:#334155;border-left:3px solid #1877c0;padding-left:10px;font-style:italic">${esc(note)}</p>` : ''}
    <table style="border-collapse:collapse;margin:12px 0">
      ${row('Requisition', req.code)}
      ${row('Position', req.designation)}
      ${row('Unit', req.unitFactory)}
      ${row('Department', req.department)}
      ${row('Posts', req.requiredPosts)}
      ${row('Type', req.requirementType === 'NEW' ? 'New position' : 'Replacement')}
      ${row('Raised by', req.raisedBy)}
    </table>
    <p style="margin:20px 0"><a href="${link}" style="background:#1877c0;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:bold;font-size:14px">Review and decide</a></p>
    <p style="font-size:12px;color:#94a3b8">The link is personal to you and works for ${VOTE_TTL_DAYS} days. The first board member to decide settles the requisition.</p>
  </div>`;
}
