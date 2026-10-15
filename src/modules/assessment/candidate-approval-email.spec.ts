import {
  candidateApprovalEmail,
  candidateApprovalSubject,
  panelSummary,
  type ApprovalEmailRow,
} from './candidate-approval-email';

/**
 * One email per send — a single candidate, or the whole batch in one table —
 * with one link to a page where the Head decides. Never a one-click decision
 * in the mail itself: link scanners open every link they find.
 */

const ROW: ApprovalEmailRow = {
  name: 'Afroja Parvin',
  post: 'Junior Executive',
  code: 'REQ-2026-002',
  unit: 'DBL Industrial Park Ltd.',
  score: '34.5 / 50',
  panel: 'Select 2',
};

describe('candidateApprovalEmail', () => {
  it('names the one candidate when one was sent', () => {
    const mail = candidateApprovalEmail({
      headName: 'Head Example',
      submittedBy: 'Omar Faruque',
      rows: [ROW],
      link: 'https://talenthub.example/candidate-approval/T',
    });
    expect(mail.subject).toBe(
      'Candidate approval — Afroja Parvin · Junior Executive',
    );
    expect(mail.html).toContain('Review and approve</a>');
    expect(mail.text).toContain('Afroja Parvin — Junior Executive');
  });

  it('puts a whole batch in one email, with one link for all of them', () => {
    const rows = [
      ROW,
      { ...ROW, name: 'Second Candidate' },
      { ...ROW, name: 'Third' },
    ];
    const mail = candidateApprovalEmail({
      headName: 'Head Example',
      submittedBy: 'Omar Faruque',
      rows,
      note: 'Strong batch',
      link: 'https://talenthub.example/candidate-approval/T',
    });
    expect(mail.subject).toBe(
      'Candidate approval — 3 candidates · Junior Executive',
    );
    expect(mail.html).toContain('Review and approve 3 candidates');
    expect(mail.html).toContain('approve them all at once');
    for (const r of rows) expect(mail.html).toContain(r.name);
    // The only link is the page; nothing in the mail decides on opening.
    expect(mail.html.match(/<a /g)).toHaveLength(1);
  });

  it('says "N candidates" without a post when the batch spans posts', () => {
    expect(candidateApprovalSubject([ROW, { ...ROW, post: 'Officer' }])).toBe(
      'Candidate approval — 2 candidates',
    );
  });

  it('escapes what people typed', () => {
    const mail = candidateApprovalEmail({
      headName: 'Head',
      submittedBy: 'X',
      rows: [{ ...ROW, name: '<script>x</script>' }],
      note: '<b>hi</b>',
      link: 'https://x/T',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>hi</b>');
  });
});

describe('panelSummary', () => {
  it('counts the panel’s recommendations, most favourable first', () => {
    expect(
      panelSummary(['reject', 'select', 'select', 'talent_pool', null]),
    ).toBe('Select 2 · Talent Pool 1 · Reject 1');
    expect(panelSummary([null, null])).toBeNull();
  });
});
