/**
 * Writes the musical-position and automation fixture. Same split as the ASL,
 * MIDI, tempo and clip emitters.
 *
 *   npm run fixtures:session
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSessionConformanceFixture } from '../src/automation/sessionConformance';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-session-fixtures.mjs <output path>');

const fixture = buildSessionConformanceFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

const written = fixture.lanes.reduce(
  (total, lane) => total + lane.samples.filter((sample) => sample.value !== null).length,
  0,
);
console.log(
  `wrote ${fixture.signatures.length} signatures, ${fixture.positions.length} positions, ` +
    `${fixture.easings.length} easing probes, ${fixture.lanes.length} lanes (${written} writes), ` +
    `${fixture.lerps.length} lerps, ${fixture.display127.length} maps to ${out}\nstamp ${fixture.stamp}`,
);
