/**
 * HR layering: each unit's Factory HR holders in priority order, always
 * numbered 1..n with no gaps.
 *
 * Kept contiguous on every change rather than only when somebody drags the
 * list: a newly added Factory HR goes to the end, and removing one closes the
 * gap — so taking the first priority off (say, to make them Factory HR Head)
 * leaves 1 and 2, not 2 and 3. Decorator-free so a test can import it.
 */

/** Roles whose holders are layered per unit. Factory HR today. */
export const LAYERED_ROLE_KEYS: readonly string[] = ['factory_hr'];

export interface LayerRow {
  id: string;
  priority: number | null;
  createdAt: Date;
}

/**
 * The order a unit's queue should be numbered in: the existing order first,
 * then anyone unordered by when they were added — which is what puts a new
 * holder last.
 */
export function layerOrder(rows: LayerRow[]): string[] {
  return [...rows]
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        if (a.priority === null) return 1;
        if (b.priority === null) return -1;
        return a.priority - b.priority;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map((r) => r.id);
}
