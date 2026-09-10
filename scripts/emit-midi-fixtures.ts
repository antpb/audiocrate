/**
 * Writes the MIDI host-jack fixture a second implementation is checked against.
 *
 * The same split as `emit-asl-fixtures.ts`: the fixture is a value built by
 * `src/midi/midiConformance.ts`, so `midiConformance.test.ts` can rebuild it
 * and notice when the file on disk no longer matches the code. This is only
 * the part that needs a filesystem.
 *
 *   npm run fixtures:midi
 *
 * or by hand, from `packages/crate`:
 *
 *   npx esbuild scripts/emit-midi-fixtures.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/emit-midi.mjs \
 *   && node /tmp/emit-midi.mjs fixtures/midi-conformance.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildMidiConformanceFixture } from '../src/midi/midiConformance';

// Given on the command line, because this is run from a bundle in a temp
// directory and `import.meta.url` would resolve against that instead of the
// package.
const out = process.argv[2];
if (!out) throw new Error('usage: node emit-midi-fixtures.mjs <output path>');

const fixture = buildMidiConformanceFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

const ticks = fixture.output.reduce((total, entry) => total + entry.ticks.length, 0);
const steps = fixture.monitor.reduce((total, entry) => total + entry.steps.length, 0);
console.log(
  `wrote ${fixture.parse.length} parse, ${fixture.monitor.length} monitor (${steps} steps), ` +
    `${fixture.output.length} convertor (${ticks} ticks), ${fixture.encode.length} encode, ` +
    `${fixture.scalars.length} scalar cases to ${out}\nstamp ${fixture.stamp}`,
);
