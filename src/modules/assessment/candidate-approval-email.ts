/**
 * The Candidate Approval email — what a Factory HR Head receives when Factory
 * HR sends finalists after a first interview (2026-10-15).
 *
 * ONE email per send: a single candidate, or every candidate of a batch in
 * one table. Its button opens a page where the Head decides without signing
 * in — each candidate on its own, or all at once.
 *
 * The decisions are deliberately on that page and not one-click links in the
 * mail: Outlook Safe Links, Gmail and virus scanners open every link in an
 * email to check it, and a link that approved on opening would approve
 * candidates nobody had read.
 *
 * Decorator-free so a test can import it.
 */

export const CANDIDATE_APPROVAL_LINK_DAYS = 14;

export interface ApprovalEmailRow {
  name: string;
  post: string;
  code: string;
  unit: string;
  /** "34.5 / 50", or null before anyone has marked. */
  score: string | null;
  /** "Select 2 · Talent Pool 1", or null. */
  panel: string | null;
}

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/** "Select 2 · Reject 1 · Talent Pool 1" from the panel's recommendations. */
export function panelSummary(
  recs: ('select' | 'reject' | 'talent_pool' | null)[],
): string | null {
  const label = {
    select: 'Select',
    reject: 'Reject',
    talent_pool: 'Talent Pool',
  };
  const counts = new Map<string, number>();
  for (const r of recs)
    if (r) counts.set(label[r], (counts.get(label[r]) ?? 0) + 1);
  const parts = ['Select', 'Talent Pool', 'Reject']
    .filter((k) => counts.has(k))
    .map((k) => `${k} ${counts.get(k)}`);
  return parts.length ? parts.join(' · ') : null;
}

export function candidateApprovalSubject(rows: ApprovalEmailRow[]): string {
  if (rows.length === 1) {
    return `Candidate approval — ${rows[0].name} · ${rows[0].post}`;
  }
  const posts = new Set(rows.map((r) => r.post));
  return posts.size === 1
    ? `Candidate approval — ${rows.length} candidates · ${rows[0].post}`
    : `Candidate approval — ${rows.length} candidates`;
}

export function candidateApprovalEmail(input: {
  headName: string;
  submittedBy: string;
  rows: ApprovalEmailRow[];
  note?: string | null;
  link: string;
}): { subject: string; html: string; text: string } {
  const { rows } = input;
  const one = rows.length === 1;
  const subject = candidateApprovalSubject(rows);
  const lead = one
    ? `${input.submittedBy} has put <strong>${esc(rows[0].name)}</strong> through the first interview and sent them for your approval.`
    : `${input.submittedBy} has put <strong>${rows.length} candidates</strong> through the first interview and sent them for your approval.`;

  const th =
    'padding:8px 10px;border:1px solid #dce4ee;background:#f1f5f9;font-size:12px;font-weight:700;color:#334155;text-align:left';
  const td =
    'padding:8px 10px;border:1px solid #e2e8f0;font-size:13px;color:#0f172a;vertical-align:top';
  const table = `<table style="border-collapse:collapse;width:100%;margin:14px 0">
    <tr>
      <th style="${th}">Candidate</th>
      <th style="${th}">Position</th>
      <th style="${th}">Interview score</th>
      <th style="${th}">Panel recommends</th>
    </tr>
    ${rows
      .map(
        (r) => `<tr>
      <td style="${td}"><strong>${esc(r.name)}</strong></td>
      <td style="${td}">${esc(r.post)}<div style="color:#64748b;font-size:11px">${esc(r.code)} · ${esc(r.unit)}</div></td>
      <td style="${td};white-space:nowrap">${esc(r.score ?? '—')}</td>
      <td style="${td}">${esc(r.panel ?? '—')}</td>
    </tr>`,
      )
      .join('')}
  </table>`;

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:640px">
    <p style="font-size:14px">Dear ${esc(input.headName)},</p>
    <p style="font-size:14px;line-height:1.6">${lead}</p>
    ${input.note ? `<p style="font-size:13px;color:#334155;border-left:3px solid #1877c0;padding-left:10px;font-style:italic">${esc(input.note)}</p>` : ''}
    ${table}
    <p style="margin:22px 0"><a href="${input.link}" style="background:#1877c0;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;font-size:14px">${one ? 'Review and approve' : `Review and approve ${rows.length} candidates`}</a></p>
    <p style="font-size:13px;color:#334155;line-height:1.6">${
      one
        ? 'You can approve, return to Factory HR or reject — returning or rejecting asks for a reason.'
        : 'You can decide each candidate on its own, or approve them all at once. Returning to Factory HR or rejecting asks for a reason.'
    } Approved candidates go to the Corporate Recruiter for the second interview.</p>
    <p style="font-size:12px;color:#94a3b8">No sign-in needed. The link is personal to you and works for ${CANDIDATE_APPROVAL_LINK_DAYS} days. If another Factory HR Head decides a candidate first, that decision stands.</p>
  </div>`;

  const text = [
    `Dear ${input.headName},`,
    '',
    one
      ? `${input.submittedBy} has put ${rows[0].name} through the first interview and sent them for your approval.`
      : `${input.submittedBy} has put ${rows.length} candidates through the first interview and sent them for your approval.`,
    ...(input.note ? ['', `"${input.note}"`] : []),
    '',
    ...rows.map(
      (r) =>
        `- ${r.name} — ${r.post} (${r.code}, ${r.unit})${r.score ? ` · score ${r.score}` : ''}${r.panel ? ` · panel: ${r.panel}` : ''}`,
    ),
    '',
    `Review and approve: ${input.link}`,
    '',
    `No sign-in needed. The link is personal to you and works for ${CANDIDATE_APPROVAL_LINK_DAYS} days.`,
  ].join('\n');

  return { subject, html, text };
}
