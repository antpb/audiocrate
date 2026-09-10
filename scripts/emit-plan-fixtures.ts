/**
 * Writes the scene plan fixture. Same split as the other emitters.
 *
 *   npm run fixtures:plan
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildPlanConformanceFixture } from '../src/session/planConformance';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-plan-fixtures.mjs <output path>');

const fixture = buildPlanConformanceFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

const windows = fixture.cases.reduce(
  (total, entry) =>
    total +
    entry.schedules.reduce(
      (sum, schedule) =>
        sum + schedule.tracks.reduce((n, t) => n + t.clips.reduce((m, c) => m + c.windows.length, 0), 0),
      0,
    ),
  0,
);
console.log(
  `wrote ${fixture.cases.length} plans, ` +
    `${fixture.cases.reduce((n, c) => n + c.probes.length, 0)} schedules, ${windows} windows ` +
    `to ${out}\nplan format v${fixture.planVersion}, stamp ${fixture.stamp}`,
);
