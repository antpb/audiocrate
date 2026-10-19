/**
 * Writes the crate.plugin format fixture: real materials as format 1 and
 * format 2 text, and what JavaScript renders from them. See
 * `src/patcher/pluginFormatConformance.ts`.
 *
 *   npm run fixtures:plugin-format   (from web-version/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildPluginFormatFixture } from '../src/patcher/pluginFormatConformance';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-plugin-format-fixtures.mjs <output path>');

const fixture = buildPluginFormatFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

for (const entry of fixture.cases) {
  console.log(`${entry.name}: ${entry.v1.length} -> ${entry.v2.length} bytes, ${entry.v1Nodes} -> ${entry.v2Nodes} nodes written`);
}
console.log(`wrote ${fixture.cases.length} cases to ${out}\nstamp ${fixture.stamp}`);
