/**
 * Whether a set of screening marks makes sense, said in words.
 *
 * The database refuses a mark above its total
 * (`salary_fixations_marks_within_totals`), but a refusal from there reaches
 * the person typing as a 500 with a Postgres message in it. The Pre-Interview
 * Tests table saves each box on its own as you leave it, so lowering a total
 * from 100 to 50 under a mark of 68 was enough to hit it. This is checked on
 * the merged record — what the row would hold after the save — before
 * writing.
 *
 * Decorator-free so the spec can import it.
 */

export interface ScreeningMarks {
  writtenTestTotal?: number | null;
  writtenTestObtained?: number | null;
  computerTestTotal?: number | null;
  computerTestObtained?: number | null;
  aiTestTotal?: number | null;
  aiTestObtained?: number | null;
}

const TESTS = [
  ['Written Test', 'writtenTestTotal', 'writtenTestObtained'],
  ['Computer Literacy', 'computerTestTotal', 'computerTestObtained'],
  ['AI Proficiency', 'aiTestTotal', 'aiTestObtained'],
] as const;

/** A short number: 68, 7.5 — never 68.00000001. */
const n = (v: number) => String(Math.round(v * 100) / 100);

/** What is wrong with these marks, or null when nothing is. */
export function screeningMarkProblem(marks: ScreeningMarks): string | null {
  for (const [label, totalKey, obtainedKey] of TESTS) {
    const total = marks[totalKey] ?? null;
    const obtained = marks[obtainedKey] ?? null;
    if (total !== null && total <= 0) {
      return `${label}: the total must be more than 0.`;
    }
    if (obtained !== null && obtained < 0) {
      return `${label}: the mark obtained cannot be below 0.`;
    }
    if (total !== null && obtained !== null && obtained > total) {
      return `${label}: ${n(obtained)} obtained is more than the total of ${n(total)}. Correct the marks and save again.`;
    }
  }
  return null;
}
