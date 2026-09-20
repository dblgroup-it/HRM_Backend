import {
  ACCEPT_DATE_MARKER,
  ACCEPT_SIGN_MARKER,
  signatureInk,
} from './letters';

/**
 * Fill a candidate's half of a stored offer letter.
 *
 * The letter in `offerLetterHtml` is the one that went out and must not
 * change — the candidate holds a copy. So accepting online renders a second
 * document from it, with their signature and joining date dropped into the
 * two slots the template leaves for them, and files that alongside their
 * joining papers.
 *
 * Both slots are matched on their marker class rather than on the surrounding
 * prose. Reaching into stored HTML is unavoidable here (the letter was
 * rendered weeks ago and its inputs are gone), so the seam is a class name
 * the template owns, not a row of underscores that the next rewording moves.
 */
export function applyCandidateAcceptance(
  html: string,
  fill: { signature: string | null; joiningDate: Date | null },
): string | null {
  const signed = replaceMarker(
    html,
    ACCEPT_SIGN_MARKER,
    signatureInk(fill.signature),
  );
  const dated = replaceMarker(
    signed.html,
    ACCEPT_DATE_MARKER,
    fill.joiningDate ? `<strong>${fmtJoining(fill.joiningDate)}</strong>` : null,
  );
  // Nothing to aim at means this letter predates the markers. Filing a copy
  // that is bit-for-bit the unsigned letter would put a document called
  // "accepted" in the file with nothing in it to show they accepted, which is
  // worse than having no copy at all.
  if (!signed.found && !dated.found) return null;
  return dated.html;
}

/**
 * Swap the contents of `<span class="marker">…</span>`.
 *
 * Hand-rolled rather than a DOM parse: this runs on HTML this module wrote,
 * the marker spans never nest, and pulling in a parser to rewrite two spans
 * would be the heavier dependency. `null` leaves the slot as it is, which is
 * what an acceptance with no date given should do.
 */
function replaceMarker(
  html: string,
  marker: string,
  replacement: string | null,
): { html: string; found: boolean } {
  const open = `<span class="${marker}">`;
  const start = html.indexOf(open);
  if (start === -1) return { html, found: false };
  const from = start + open.length;
  const end = html.indexOf('</span>', from);
  if (end === -1) return { html, found: false };
  if (replacement === null) return { html, found: true };
  return {
    html: html.slice(0, from) + replacement + html.slice(end),
    found: true,
  };
}

/** "15 September 2026" — the format the letter body already uses. */
function fmtJoining(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
