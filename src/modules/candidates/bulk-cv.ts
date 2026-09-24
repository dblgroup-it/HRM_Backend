/**
 * Bulk CV upload: one candidate per file.
 *
 * Decorator-free so a test can import it. The recruiter reviews the names in
 * the upload dialog before sending; a file sent without one is named from its
 * filename, which is how CVs arrive from job boards and inboxes anyway
 * ("CV_Md_Rahim_Uddin.pdf"). Email and phone are not asked for — the AI
 * screen reads them off the CV, as it does for a single upload.
 */

/** The most CVs one request may carry. */
export const BULK_CV_MAX_FILES = 30;

const NOISE =
  /\b(cv|resume|curriculum vitae|biodata|bio data|updated|final|new|copy)\b/gi;

/** "CV_Md_Rahim_Uddin (1).pdf" -> "Md Rahim Uddin". */
export function nameFromFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/\(\d+\)/g, ' ')
    .replace(/[_\-.+]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const titled = cleaned
    .split(' ')
    .map((w) =>
      w === w.toUpperCase() || w === w.toLowerCase()
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w,
    )
    .join(' ');
  // A filename that was nothing but noise ("CV.pdf", "1234.pdf") still has to
  // produce a usable name; the recruiter can correct it on the row.
  return titled.length >= 2 ? titled.slice(0, 120) : 'Unnamed candidate';
}

/**
 * The per-file names, as the dialog sends them: a JSON array of strings in
 * the same order as the files. Anything missing, blank or unusable falls back
 * to the filename, so a malformed field never loses a CV.
 */
export function bulkCandidateNames(
  raw: string | undefined,
  fileNames: string[],
): string[] {
  let given: unknown = [];
  try {
    given = raw ? JSON.parse(raw) : [];
  } catch {
    given = [];
  }
  const list = Array.isArray(given) ? given : [];
  return fileNames.map((file, i) => {
    const v = list[i];
    const name = typeof v === 'string' ? v.trim().slice(0, 120) : '';
    return name.length >= 2 ? name : nameFromFileName(file);
  });
}
