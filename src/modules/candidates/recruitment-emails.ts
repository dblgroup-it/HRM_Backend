import { firstName } from '../../common/util/first-name';
import {
  renderBrandedEmail,
  type EmailBlock,
  type RenderedEmail,
} from '../integrations/mail/branded-email';

/**
 * The letters Talent Acquisition sends without anyone pressing send: the
 * confirmation when somebody applies on the careers page, and the pair that
 * goes out when an employee refers somebody.
 *
 * The wording is DBL's own and is fixed. Each one ends with the automated-
 * email notice, which the branded layout carries in its footer.
 *
 * Decorator-free so specs can import it.
 */

/** The vacancy, as the letters name it. */
export interface VacancyFacts {
  /** The post's title — "Senior Executive / Assistant Manager" when it has alternates. */
  position: string;
  /** The business unit / company — the requisition's unit. */
  businessUnit: string;
  /** The place of posting. */
  location: string | null;
}

export const SIGN_OFF: EmailBlock = {
  kind: 'signoff',
  lines: ['Warm regards,', 'Talent Acquisition Team', 'DBL Group'],
};

/** "Dear Rahim," — or "Dear Candidate," when there is no name to use. */
export const dear = (name: string | null | undefined, fallback: string) =>
  `Dear ${firstName(name) || fallback},`;

/**
 * The full stop after a name that ends a sentence — none when the name
 * brings its own, as "Jinnat Textile Mills Ltd." does.
 */
export const fullStop = (name: string) =>
  /[.!?]$/.test(name.trim()) ? '' : '.';

// --- Application received ---------------------------------------------------

export interface ApplicationReceivedInput extends VacancyFacts {
  candidateName: string;
  applicationId: string;
  /** The status page, opened on this applicant's own applications. */
  statusUrl: string;
  careersUrl: string;
}

export function applicationReceivedEmail(
  input: ApplicationReceivedInput,
): RenderedEmail {
  return renderBrandedEmail({
    subject: `Application Received — ${input.position} | DBL Group`,
    preheader: `We are pleased to confirm that your application for ${input.position} has been successfully received.`,
    blocks: [
      { kind: 'paragraph', content: dear(input.candidateName, 'Candidate') },
      {
        kind: 'paragraph',
        content: 'Thank you for your interest in DBL Group.',
      },
      {
        kind: 'paragraph',
        content:
          'We are pleased to confirm that your application has been successfully received.',
      },
      {
        kind: 'details',
        rows: [
          ['Position', input.position],
          ['Business Unit', input.businessUnit],
          ['Location', input.location],
          ['Application ID', input.applicationId],
        ],
      },
      { kind: 'heading', text: 'What Happens Next?' },
      {
        kind: 'paragraph',
        content:
          'Our Talent Acquisition Team will review your application against the requirements of the role. If your profile is shortlisted, we will contact you regarding the next stage of the recruitment process.',
      },
      {
        kind: 'button',
        label: 'View Application Status',
        href: input.statusUrl,
      },
      { kind: 'heading', text: 'About DBL Group' },
      {
        kind: 'paragraph',
        content:
          'Established in 1991, DBL Group is a diversified business conglomerate with operations across Textiles & Apparel, Threads & Accessories, Ceramics, Pharmaceuticals, Global Fashion Retail, and other sectors, with a workforce of more than 51,000 people.',
      },
      {
        kind: 'paragraph',
        content:
          'Driven by People, Purpose, and Progress, we are committed to creating opportunities where people can learn, grow, innovate, and make an impact.',
      },
      {
        kind: 'paragraph',
        content:
          'We are committed to a fair, transparent, inclusive, and merit-based recruitment process.',
      },
      { kind: 'heading', text: 'Explore More Opportunities' },
      {
        kind: 'paragraph',
        content:
          'Interested in other opportunities at DBL Group? Visit our Careers page to explore current openings and find roles that match your skills and aspirations.',
      },
      {
        kind: 'button',
        label: 'Explore Careers at DBL Group',
        href: input.careersUrl,
        tone: 'secondary',
      },
      {
        kind: 'paragraph',
        content:
          'Thank you for considering DBL Group as part of your career journey. We look forward to learning more about you.',
      },
      SIGN_OFF,
    ],
  });
}

// --- Employee referral: to the candidate ------------------------------------

export interface ReferredCandidateInput extends VacancyFacts {
  candidateName: string;
  referrerName: string;
  careersUrl: string;
}

export function referredCandidateEmail(
  input: ReferredCandidateInput,
): RenderedEmail {
  return renderBrandedEmail({
    subject: `You Have Been Referred — ${input.position} | DBL Group`,
    preheader: `${input.referrerName} has referred your profile for the position of ${input.position} at ${input.businessUnit}.`,
    blocks: [
      { kind: 'paragraph', content: dear(input.candidateName, 'Candidate') },
      { kind: 'paragraph', content: 'Greetings from DBL Group.' },
      {
        kind: 'paragraph',
        content: [
          'We are pleased to let you know that ',
          { strong: input.referrerName },
          ' has referred your profile for the position of ',
          { strong: input.position },
          ' at ',
          { strong: input.businessUnit },
          fullStop(input.businessUnit),
        ],
      },
      {
        kind: 'details',
        rows: [
          ['Position', input.position],
          ['Business Unit', input.businessUnit],
          ['Location', input.location],
          ['Referred By', input.referrerName],
        ],
      },
      {
        kind: 'paragraph',
        content:
          'Our Talent Acquisition Team will review your profile against the requirements of the role. If your profile aligns with the opportunity, we will contact you regarding the next steps in the recruitment process.',
      },
      {
        kind: 'paragraph',
        content:
          'We encourage you to explore DBL Group and discover other opportunities that may match your career aspirations.',
      },
      {
        kind: 'link',
        label: 'Explore Careers at DBL Group:',
        href: input.careersUrl,
      },
      {
        kind: 'paragraph',
        content:
          'At DBL Group, we are committed to a fair, transparent, inclusive, and merit-based recruitment process.',
      },
      {
        kind: 'paragraph',
        content: 'We look forward to learning more about you.',
      },
      SIGN_OFF,
    ],
  });
}

// --- Employee referral: to the referrer -------------------------------------

export interface ReferrerInput extends VacancyFacts {
  referrerName: string;
  referralId: string;
  /** Everyone sent in together, in the order they were added. */
  candidates: { name: string; email: string | null }[];
  careersUrl: string;
}

export function referrerEmail(input: ReferrerInput): RenderedEmail {
  return renderBrandedEmail({
    subject: `Referral Confirmation — ${input.position} (${input.referralId}) | DBL Group`,
    preheader: `Your referral for ${input.position} has been successfully submitted.`,
    blocks: [
      { kind: 'paragraph', content: dear(input.referrerName, 'Colleague') },
      {
        kind: 'paragraph',
        content:
          'Thank you for recommending talented professionals to DBL Group.',
      },
      {
        kind: 'paragraph',
        content:
          'Your referral has been successfully submitted. Please find the details below:',
      },
      {
        kind: 'details',
        rows: [
          ['Position', input.position],
          ['Business Unit', input.businessUnit],
          ['Location', input.location],
        ],
      },
      { kind: 'heading', text: 'Candidates Referred' },
      {
        kind: 'list',
        // A CV that carried no address is listed by name alone rather than
        // with a gap where the address should be.
        items: input.candidates.map((c) =>
          c.email?.trim() ? `${c.name} — ${c.email.trim()}` : c.name,
        ),
      },
      {
        kind: 'details',
        rows: [
          ['Total Candidates Referred', String(input.candidates.length)],
          ['Referral ID', input.referralId],
        ],
      },
      {
        kind: 'paragraph',
        content:
          'Our Talent Acquisition Team will review each candidate individually against the requirements of the role. Candidates whose profiles align with the opportunity will be contacted regarding the next stage of the recruitment process.',
      },
      {
        kind: 'paragraph',
        content:
          'We appreciate your contribution to helping DBL Group connect with talented professionals and build stronger teams.',
      },
      {
        kind: 'link',
        label: 'Explore Current Opportunities:',
        href: input.careersUrl,
      },
      SIGN_OFF,
    ],
  });
}
