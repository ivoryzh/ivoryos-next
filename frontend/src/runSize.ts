/**
 * How big a run is, in the unit that fits it. An optimization by its iterations: it makes its
 * steps one trial at a time, so a queued one has none yet and read "0 steps". A spreadsheet by
 * its steps and rows; anything else by its steps.
 */
export function runSizeLabel(run: any): string {
  const p = run?.parameters || {};
  const steps = run?.steps?.length || 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (p.type === 'Optimization') return plural(Number(p.budget) || 0, 'iteration');
  const rows = Array.isArray(p.rows) ? p.rows.length : 0;
  if (p.type === 'Spreadsheet' && rows > 0) return `${plural(steps, 'step')} · ${plural(rows, 'row')}`;
  return plural(steps, 'step');
}
