/**
 * Writes the clip placement fixture a second implementation is checked
 * against. Same split as the ASL, MIDI and tempo emitters.
 *
 *   npm run fixtures:clip
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildClipConformanceFixture } from '../src/clip/clipConformance';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-clip-fixtures.mjs <output path>');

const fixture = buildClipConformanceFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

const emitted = fixture.windows.reduce((total, entry) => total + entry.windows.length, 0);
console.log(
  `wrote ${fixture.windows.length} placements (${emitted} windows), ${fixture.durations.length} durations, ` +
    `${fixture.trims.length} trims, ${fixture.warpConversions.length} conversions, ` +
    `${fixture.fades.length} fade probes, ${fixture.gains.length} gain probes to ${out}\nstamp ${fixture.stamp}`,
);
