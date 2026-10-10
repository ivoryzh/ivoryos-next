// The expected datasheets in tests/fixtures/run_datasheets.json are what formatRun produces. The
// edge's Python reading is checked against the same file (tests/automated/test_datasheet.py), so
// the two cannot come to disagree about which value belongs to which sample.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedFor, readFixtures } from './datasheetFixtures.mjs';

for (const c of readFixtures().cases) {
  test(c.name, async () => {
    assert.ok(c.expected, 'no expected datasheet yet: run node packages/shared-ui/test/write-datasheet-fixtures.mjs');
    assert.deepEqual(await expectedFor(c.record), c.expected,
      'formatRun changed: rewrite the fixtures, then bring ivoryos_edge/datasheet.py in line');
  });
}
