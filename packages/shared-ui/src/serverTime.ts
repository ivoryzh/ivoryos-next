/**
 * Times from the edge server are naive UTC -- `datetime.utcnow().isoformat()`, no offset -- and
 * JavaScript parses a date-time string without an offset as *local* time. Read raw, every run
 * time was shown in UTC while labelled as local (a run started at 11:52 PM Pacific read "6:52 AM").
 * Anything displaying or comparing an edge timestamp goes through here.
 */
export function parseServerTime(value?: string | null): number {
  if (!value) return NaN;
  return Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
}

/** An edge timestamp as a local Date (Invalid Date when missing). */
export const serverDate = (value?: string | null) => new Date(parseServerTime(value));
