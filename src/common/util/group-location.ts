/**
 * Every DBL location is named under the group: "DBL Group, Mymun Complex".
 *
 * The job-location list stores the bare site name (it is also matched
 * against older requisitions and venues), so the group is added wherever a
 * location is shown in a dropdown or written into a mail or letter. Empty in,
 * empty out; a value that already carries the group is left alone.
 */
export const LOCATION_GROUP = 'DBL Group';

export function groupLocation(location: string | null | undefined): string {
  const loc = (location ?? '').trim();
  if (!loc) return '';
  if (loc.toLowerCase().startsWith(LOCATION_GROUP.toLowerCase())) return loc;
  return `${LOCATION_GROUP}, ${loc}`;
}

/** The inverse, for a value that may or may not carry the group. */
export function ungroupLocation(location: string): string {
  const prefix = `${LOCATION_GROUP}, `;
  return location.toLowerCase().startsWith(prefix.toLowerCase())
    ? location.slice(prefix.length)
    : location;
}
