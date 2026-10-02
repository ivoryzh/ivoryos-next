'use strict';

// "Tidy up" on a long workflow: one column per step ran far off the screen, so a layout taller
// than the canvas wraps into columns (canvasLayout.ts wrapColumns). The module is TypeScript;
// Node strips its types on import.

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('./canvasLayout.ts');

const step = (id, x = 0, y = 0) => ({
  id, position: { x, y }, measured: { width: 260, height: 100 },
  data: { block: { instrument: 'pump', method: 'move' } },
});
const start = () => ({ id: 'start', position: { x: 0, y: 0 }, measured: { width: 150, height: 57 }, data: { block: { instrument: 'Flow Control', method: 'Start' } } });
const chain = (n) => {
  const nodes = [start(), ...Array.from({ length: n }, (_, i) => step(`s${i}`))];
  const edges = nodes.slice(1).map((m, i) => ({ id: `e${i}`, source: nodes[i].id, target: m.id }));
  return { nodes, edges };
};
// A step's column, by its centre: snapping to the 20px grid moves a centre by up to 10px.
const centre = (n) => Math.round((n.position.x + n.measured.width / 2) / 100);
const columnsOf = (laid) => [...new Set(laid.map(centre))].sort((a, b) => a - b);

test('a chain that fits stays one column', async () => {
  const { tidyLayout } = await load();
  const { nodes, edges } = chain(3);
  const laid = tidyLayout(nodes, edges, { maxHeight: 2000 });
  assert.equal(columnsOf(laid).length, 1);
});

test('a long chain wraps into balanced columns, read left to right, each starting at the top', async () => {
  const { tidyLayout } = await load();
  const { nodes, edges } = chain(19); // Start + 19 steps, 20 rows of ~170 = ~3200 tall
  const laid = tidyLayout(nodes, edges, { maxHeight: 1000 });
  const byId = Object.fromEntries(laid.map(n => [n.id, n]));
  const cols = columnsOf(laid);
  assert.equal(cols.length, 4);
  // Order is kept: each step is either below its predecessor or at the top of the next column.
  for (let i = 1; i < 19; i++) {
    const a = byId[`s${i - 1}`], b = byId[`s${i}`];
    const sameColumn = centre(a) === centre(b);
    assert.ok(sameColumn ? b.position.y > a.position.y : centre(b) > centre(a), `s${i} follows s${i - 1}`);
    if (!sameColumn) assert.equal(b.position.y, byId.start.position.y, `s${i} starts its column at the top`);
  }
  // No column is taller than asked, and they are roughly even.
  const heights = cols.map(c => {
    const inCol = laid.filter(n => centre(n) === c);
    return Math.max(...inCol.map(n => n.position.y + n.measured.height)) - Math.min(...inCol.map(n => n.position.y));
  });
  assert.ok(Math.max(...heights) <= 1000 * 1.1, `heights ${heights}`);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 400, `heights ${heights}`);
  // Start does not move, so the view does not jump.
  assert.deepEqual(byId.start.position, { x: 0, y: 0 });
});

test('a cut goes above a single step rather than through a branch', async () => {
  const { tidyLayout } = await load();
  // Start -> a -> b -> {c1, c2} -> d -> e -> f ... : rows 3 is two steps wide.
  const nodes = [start(), step('a'), step('b'), step('c1'), step('c2'), step('d'), step('e'), step('f'), step('g')];
  const edges = [['start', 'a'], ['a', 'b'], ['b', 'c1'], ['b', 'c2'], ['c1', 'd'], ['c2', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'g']]
    .map(([source, target], i) => ({ id: `e${i}`, source, target }));
  const laid = tidyLayout(nodes, edges, { maxHeight: 560 });
  const byId = Object.fromEntries(laid.map(n => [n.id, n]));
  // The two branches share a row, so they stay in one column with the step they come from.
  assert.equal(byId.c1.position.y, byId.c2.position.y);
  const top = byId.start.position.y;
  assert.ok(laid.some(n => n.id !== 'start' && n.position.y === top), 'it wrapped');
  // The plain cut would have been above the branch row; it moved up to the single step b.
  assert.equal(byId.b.position.y, top);
  assert.notEqual(byId.c1.position.y, top);
});
