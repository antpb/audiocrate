/**
 * Writes the tempo map fixture a second implementation is checked against.
 *
 * Same split as the ASL and MIDI emitters: the fixture is a value built by
 * `src/tempoConformance.ts`, so a test can rebuild it and notice when the file
 * on disk no longer matches the code. This is only the part that needs a
 * filesystem.
 *
 *   npm run fixtures:tempo
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildTempoConformanceFixture } from '../src/tempoConformance';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-tempo-fixtures.mjs <output path>');

const fixture = buildTempoConformanceFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

const exact = fixture.maps.filter((entry) => entry.exact).length;
const queries = fixture.maps.reduce((total, entry) => total + entry.queries.length, 0);
console.log(
  `wrote ${fixture.maps.length} maps (${exact} held to the bit), ${queries} queries to ${out}\nstamp ${fixture.stamp}`,
);
