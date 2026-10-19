/**
 * Writes the motion conformance fixture: every palette material rendered
 * while its parameters move. See `editor/src/motionConformance.ts`.
 *
 *   npm run fixtures:motion   (from web-version/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildMotionFixture } from '../src/motionConformance';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-motion-fixtures.mjs <output path>');

const fixture = buildMotionFixture();
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(fixture, null, 0);
writeFileSync(out, json);
console.log(
  `wrote ${fixture.cases.length} materials in motion (${fixture.silent.length} silent, left out: ` +
    `${fixture.silent.join(', ') || 'none'}) ${(json.length / 1024).toFixed(0)} KB to ${out}\nstamp ${fixture.stamp}`,
);
