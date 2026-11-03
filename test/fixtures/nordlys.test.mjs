// Graded regression: Nordlys Cabins at each layer must keep its known isitagentready level and layer scores.
// UPDATE_SNAPSHOTS=1 rewrites test/fixtures/expected/nordlys.json. BROWSER=1 adds the browser checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanNode } from '../../src/node/index.mjs';
import { startNordlys, hasDemos, FIXTURES } from './nordlys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SNAP = join(here, 'expected', process.env.BROWSER === '1' ? 'nordlys-browser.json' : 'nordlys.json');
const update = process.env.UPDATE_SNAPSHOTS === '1';
const expected = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : {};
const actual = {};

export function summarize(report) {
  return {
    iia_level: report.compat.isitagentready.level,
    score: report.score,
    layers: Object.fromEntries(report.layers.map((l) => [l.id, l.score])),
    lighthouse: report.compat.lighthouse_agentic.score,
    statuses: Object.fromEntries(report.checks.map((c) => [c.id, c.status])),
  };
}

for (const fx of FIXTURES) {
  test(`nordlys ${fx.name}`, { skip: !hasDemos() && 'demos checkout not found (set DEMOS_DIR)', timeout: 120_000 }, async () => {
    const site = await startNordlys(fx);
    try {
      const report = await scanNode(site.url + '/', { allowPrivate: true, browser: process.env.BROWSER === '1' });
      const s = summarize(report);
      actual[fx.name] = s;
      if (!update && expected[fx.name]) {
        assert.equal(s.iia_level, expected[fx.name].iia_level, 'isitagentready level');
        assert.deepEqual(s.layers, expected[fx.name].layers, 'layer scores');
        assert.deepEqual(s.statuses, expected[fx.name].statuses, 'check statuses');
      }
    } finally { site.close(); }
  });
}

test('write snapshots', { skip: !update || !hasDemos() }, () => {
  mkdirSync(dirname(SNAP), { recursive: true });
  writeFileSync(SNAP, JSON.stringify({ ...expected, ...actual }, null, 1) + '\n');
});
