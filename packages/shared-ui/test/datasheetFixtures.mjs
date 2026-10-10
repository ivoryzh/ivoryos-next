// The cases in tests/fixtures/run_datasheets.json, read as Data History reads them: what both the
// TypeScript test here and the edge's Python test (tests/automated/test_datasheet.py) compare to.
import fs from 'node:fs';
import { importSource } from './tsImport.mjs';

export const FIXTURES = new URL('../../../tests/fixtures/run_datasheets.json', import.meta.url);

/** The part of a formatted run both readings must agree on, as plain JSON. */
export async function expectedFor(record) {
  const { formatRun } = await importSource('runRecord');
  const run = formatRun(record);
  return JSON.parse(JSON.stringify({
    type: run.type,
    variables: run.variables,
    rows: run.rows.map((r) => ({ row: r.row, status: r.status, values: r.values })),
    deck_version: run.deckVersion,
    batch_size: run.batchSize,
    prep: run.prep.map((s) => s.status),
    cleanup: run.cleanup.map((s) => s.status),
  }));
}

export const readFixtures = () => JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
