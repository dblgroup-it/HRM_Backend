/**
 * The regret letter to a rejected candidate.
 *
 * Opt-in: rejecting somebody never mails them by itself. Factory HR (for the
 * candidates handed to them) and the recruiter choose to send it, one
 * candidate or many at once. The wording is DBL's own and is fixed — it is
 * the same letter whoever sends it, so it is not edited per send.
 *
 * Decorator-free so the spec can import it.
 */

export const REGRET_MAIL_BODY = [
  'Dear Applicant,',
  '',
  'Greetings from DBL Group.',
  '',
  'Thank you for your interest in DBL Group and for taking the time to participate in our selection process. We appreciate the opportunity to learn more about your experience and expertise.',
  '',
  'After careful consideration of the requirements of the position and the candidates assessed, we regret to inform you that we have decided to proceed with another candidate whose profile more closely matches the current requirements of the role.',
  '',
  'We appreciate your interest in DBL Group and will retain your CV in our database for consideration for future opportunities that may be relevant to your profile.',
  '',
  'We wish you every success in your career and future endeavors.',
  '',
  'Best Regards,',
  'HR Department',
  'DBL Group',
].join('\n');

export function regretMailSubject(designation: string | null | undefined): string {
  const role = designation?.trim();
  return role
    ? `Application Update — ${role} | DBL Group`
    : 'Application Update | DBL Group';
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
