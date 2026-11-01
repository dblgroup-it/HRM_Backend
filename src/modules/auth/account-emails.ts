import { firstName } from '../../common/util/first-name';
import {
  renderBrandedEmail,
  type EmailBlock,
  type RenderedEmail,
} from '../integrations/mail/branded-email';

/**
 * The two letters a person gets about their own TalentHub account (owner's
 * request, 2026-11-01): one when they are given a role, one when a super user
 * resets their password.
 *
 * The password is written out only when the account still holds the shared
 * default, which everyone with access is told anyway, and every account
 * holding it must change it at its next sign-in. Never in a subject: with
 * email switched off, MailService logs the subject.
 *
 * Decorator-free so specs can import it.
 */

export interface AccessRole {
  /** The role's display name — "Factory HR". */
  role: string;
  /** The unit it applies to, or null for a global role. */
  unit: string | null;
}

interface SignIn {
  name: string;
  employeeCode: string;
  /** The sign-in page. */
  signInUrl: string;
  /**
   * The default password, when the account still holds it. Null when they
   * have their own, which this letter must not pretend to know.
   */
  defaultPassword: string | null;
}

export interface AccessGrantedInput extends SignIn {
  /** The roles just given, in the order they were given. */
  granted: AccessRole[];
  /**
   * No role before these: this is their first way in, and the only letter
   * that carries the user ID and password (owner's decision, 2026-11-01).
   * Anyone who already had access is told what was added, nothing more.
   */
  firstAccess: boolean;
}

export interface PasswordResetInput extends SignIn {
  defaultPassword: string;
  /** Two-step sign-in was on and the reset turned it off. */
  twoFactorWasOn: boolean;
}

const SIGN_OFF: EmailBlock = {
  kind: 'signoff',
  lines: ['Regards,', 'TalentHub Administrator', 'DBL Group'],
};

const dear = (name: string) => `Dear ${firstName(name) || 'Colleague'},`;

function signInBlocks(input: SignIn): EmailBlock[] {
  return [
    { kind: 'heading', text: 'How to sign in' },
    {
      kind: 'details',
      rows: [
        ['Website', input.signInUrl],
        ['User ID', input.employeeCode],
        ['Default password', input.defaultPassword],
      ],
    },
    input.defaultPassword
      ? {
          kind: 'paragraph',
          content: [
            {
              strong:
                'You will be asked to choose your own password the first time you sign in.',
            },
            ' Nothing else opens until you do.',
          ],
        }
      : {
          kind: 'paragraph',
          content:
            'Sign in with your usual TalentHub password. If you do not remember it, use Forgot password? on the sign-in page.',
        },
    { kind: 'button', label: 'Sign in to TalentHub', href: input.signInUrl },
  ];
}

export function accessGrantedEmail(input: AccessGrantedInput): RenderedEmail {
  const roles: EmailBlock = {
    kind: 'details',
    rows: input.granted.map((g) => [g.role, g.unit ?? 'All units'] as const),
  };

  if (!input.firstAccess) {
    const lead = 'You now also have the following access in TalentHub:';
    return renderBrandedEmail({
      subject: 'New access in TalentHub',
      preheader: lead,
      blocks: [
        { kind: 'paragraph', content: dear(input.name) },
        { kind: 'paragraph', content: lead },
        roles,
        {
          kind: 'paragraph',
          content: 'Sign in as usual; nothing about your sign-in has changed.',
        },
        {
          kind: 'button',
          label: 'Open TalentHub',
          href: input.signInUrl,
        },
        SIGN_OFF,
      ],
    });
  }

  const lead =
    'You have been given access to TalentHub, DBL Group’s recruitment system.';
  return renderBrandedEmail({
    subject: 'Your TalentHub access and sign-in details',
    preheader: lead,
    blocks: [
      { kind: 'paragraph', content: dear(input.name) },
      { kind: 'paragraph', content: lead },
      {
        kind: 'heading',
        text: input.granted.length === 1 ? 'Your role' : 'Your roles',
      },
      roles,
      ...signInBlocks(input),
      {
        kind: 'paragraph',
        content:
          'The Tutorials page in TalentHub has a guide for each role, with videos.',
      },
      SIGN_OFF,
    ],
  });
}

export function passwordResetEmail(input: PasswordResetInput): RenderedEmail {
  return renderBrandedEmail({
    subject: 'Your TalentHub password has been reset',
    preheader:
      'For security purposes, your TalentHub password has been reset by the Administrator.',
    blocks: [
      { kind: 'paragraph', content: dear(input.name) },
      {
        kind: 'paragraph',
        content:
          'For security purposes, your TalentHub password has been reset by the Administrator.',
      },
      ...signInBlocks(input),
      ...(input.twoFactorWasOn
        ? [
            {
              kind: 'paragraph',
              content:
                'Two-step verification has been turned off. You can turn it on again in Settings › Security.',
            } satisfies EmailBlock,
          ]
        : []),
      {
        kind: 'paragraph',
        content:
          'If you did not expect this, contact your administrator straight away.',
      },
      SIGN_OFF,
    ],
  });
}
