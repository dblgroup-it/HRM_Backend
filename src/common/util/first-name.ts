/**
 * The name to open a letter with — "Dear Rahim," for Md. Rahim Uddin.
 *
 * Names here usually begin with something that is not what anyone is called:
 * a title (Mr., Dr., Engr.), the Md. / Mst. that prefixes a great many
 * Bangladeshi names, or initials (A.K.M., S.M.). Those are skipped, and the
 * first word after them is the name. Abdul / Abdur / Abu and their kin are
 * not names on their own, nor is Al (Al Amin), so the word after them comes
 * too ("Abdur Rahman", "Al Amin").
 * A name typed all in capitals or all in lower case is written properly.
 *
 * When nothing is left after the prefixes — someone entered only "Mohammad" —
 * the whole name is used rather than nothing.
 *
 * The frontend's regret-mail preview keeps a copy of this
 * (`HRM_Frontend/src/shared/utils/firstName.ts`); keep the two in step.
 */

const PREFIXES = new Set([
  'md',
  'mohd',
  'mohammad',
  'mohammed',
  'muhammad',
  'muhammed',
  'mohamed',
  'mst',
  'most',
  'mosammat',
  'mosammet',
  'mosamat',
  'mr',
  'mrs',
  'ms',
  'miss',
  'mister',
  'dr',
  'engr',
  'eng',
  'prof',
  'sk',
  'sheikh',
  'shaikh',
  'syed',
  'sayed',
  'hafez',
  'hafiz',
]);

/** Initials as they are usually written without the dots ("AKM Fazlul Haque"). */
const INITIALISMS = new Set([
  'akm',
  'abm',
  'ahm',
  'atm',
  'afm',
  'asm',
  'ajm',
  'amm',
  'skm',
  'sm',
  'km',
]);

/** Names that need the word after them to be a name. */
const JOINED = new Set([
  'abdul',
  'abdur',
  'abdus',
  'abdun',
  'abu',
  'abul',
  // Al Amin, Al Mamun, Al Imran — "Dear Al," is not a name.
  'al',
  'el',
]);

const bare = (word: string) => word.replace(/[.,]/g, '').toLowerCase();

/** "A.K.M.", "S.M", "M.", "AKM" — initials, not a name. */
const isInitials = (word: string) =>
  (/^([A-Za-z]\.?){1,4}$/.test(word) &&
    (word.includes('.') || word.length === 1)) ||
  INITIALISMS.has(bare(word));

function properCase(word: string): string {
  if (word !== word.toUpperCase() && word !== word.toLowerCase()) return word;
  return word
    .toLowerCase()
    .replace(
      /(^|[-'])(\p{L})/gu,
      (_, sep: string, ch: string) => sep + ch.toUpperCase(),
    );
}

export function firstName(fullName: string | null | undefined): string {
  const words = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  let i = 0;
  while (
    i < words.length &&
    (PREFIXES.has(bare(words[i])) || isInitials(words[i]))
  ) {
    i++;
  }
  if (i >= words.length) return words.map(properCase).join(' ');
  const name = [words[i]];
  if (JOINED.has(bare(words[i])) && words[i + 1]) name.push(words[i + 1]);
  return name.map((w) => properCase(w.replace(/[,]+$/, ''))).join(' ');
}
