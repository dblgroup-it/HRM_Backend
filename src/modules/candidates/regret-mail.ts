import {
  renderBrandedEmail,
  type RenderedEmail,
} from '../integrations/mail/branded-email';
import { dear, fullStop, SIGN_OFF } from './recruitment-emails';

/**
 * The regret letter to a rejected candidate.
 *
 * Opt-in: rejecting somebody never mails them by itself. Factory HR (for the
 * candidates handed to them) and the recruiter choose to send it, one
 * candidate or many at once. The wording is DBL's own and is fixed — the same
 * letter whoever sends it, addressed to each candidate by name and naming the
 * post they applied for.
 *
 * The frontend shows a preview copy (`HRM_Frontend/src/modules/candidates/
 * regretMail.ts`); keep the two in step.
 *
 * Decorator-free so the spec can import it.
 */

export interface RegretMailInput {
  candidateName: string;
  /** The post's title, as `designationLabel` writes it. */
  position: string;
  careersUrl: string;
}

export function regretMailSubject(
  designation: string | null | undefined,
): string {
  const role = designation?.trim();
  return role
    ? `Application Update — ${role} | DBL Group`
    : 'Application Update | DBL Group';
}

export function regretMail(input: RegretMailInput): RenderedEmail {
  const position = input.position.trim();
  return renderBrandedEmail({
    subject: regretMailSubject(position),
    preheader:
      'Thank you for your interest in DBL Group and for the time and effort you invested in our recruitment process.',
    blocks: [
      { kind: 'paragraph', content: dear(input.candidateName, 'Candidate') },
      {
        kind: 'paragraph',
        content: position
          ? [
              'Thank you for your interest in DBL Group and for the time and effort you invested in our recruitment process for the position of ',
              { strong: position },
              fullStop(position),
            ]
          : 'Thank you for your interest in DBL Group and for the time and effort you invested in our recruitment process.',
      },
      {
        kind: 'paragraph',
        content:
          'After careful consideration of your application and the requirements of the role, we have decided not to proceed with your candidature for this position.',
      },
      {
        kind: 'paragraph',
        content:
          'We truly appreciate the opportunity to learn more about your experience, skills, and career aspirations. While we are unable to move forward with your application at this time, we encourage you to explore future opportunities with DBL Group that may be a strong match for your profile.',
      },
      {
        kind: 'link',
        label: 'Explore Current Opportunities:',
        href: input.careersUrl,
      },
      {
        kind: 'paragraph',
        content:
          'Where appropriate, your profile may also be considered for future opportunities aligned with your qualifications and experience.',
      },
      {
        kind: 'paragraph',
        content:
          'At DBL Group, we are committed to a fair, transparent, inclusive, and merit-based recruitment process, ensuring every candidate is assessed objectively against the requirements of the role.',
      },
      {
        kind: 'paragraph',
        content:
          'Thank you again for considering DBL Group as part of your career journey. We wish you continued success and growth in your professional endeavors.',
      },
      SIGN_OFF,
    ],
  });
}

export interface RegretEligibilityInput {
  name: string;
  stage: string;
  email: string | null;
  regretSentAt: Date | string | null;
}

/**
 * Why this candidate cannot be sent the letter, or null when they can.
 *
 * Only a rejected candidate — a regret to somebody still in the running is a
 * mistake nobody can take back. And only once: a second copy of "we regret"
 * reads as carelessness.
 */
export function regretMailBlocker(c: RegretEligibilityInput): string | null {
  if (c.stage.toUpperCase() !== 'REJECTED') {
    return `${c.name} has not been rejected.`;
  }
  if (!c.email?.trim()) return `${c.name} has no email address on file.`;
  if (c.regretSentAt) return `${c.name} has already been sent the regret mail.`;
  return null;
}
