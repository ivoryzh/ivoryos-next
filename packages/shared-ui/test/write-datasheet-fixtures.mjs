// Fill in each case's `expected` from the TypeScript reading (runRecord.ts formatRun). Run after
// changing formatRun or adding a case, then make the Python reading (ivoryos_edge/datasheet.py)
// pass tests/automated/test_datasheet.py against the new expectations:
//   node packages/shared-ui/test/write-datasheet-fixtures.mjs
import fs from 'node:fs';
import { FIXTURES, expectedFor, readFixtures } from './datasheetFixtures.mjs';

const fixtures = readFixtures();
for (const c of fixtures.cases) c.expected = await expectedFor(c.record);
fs.writeFileSync(FIXTURES, JSON.stringify(fixtures, null, 1) + '\n');
console.log(`Wrote the expected datasheet of ${fixtures.cases.length} cases.`);
