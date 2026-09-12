/**
 * Writes the patch-lowering fixture the Swift `flattenPatch` is checked
 * against.
 *
 * Same split as the other emitters: the value is built by
 * `editor/src/flattenConformance.ts` so a test can rebuild it in memory and
 * fail when the checked-in file no longer matches the code. This is only the
 * part that needs a filesystem.
 *
 *   npm run fixtures:flatten
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFlattenConformanceFixture } from '../src/flattenConformance';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-flatten-fixtures.mjs <output path>');

const fixture = buildFlattenConformanceFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

const nodes = fixture.cases.reduce((total, entry) => total + entry.expected.graph.nodes.length, 0);
const params = fixture.cases.reduce(
  (total, entry) => total + Object.keys(entry.expected.params).length,
  0,
);
console.log(
  `wrote ${fixture.cases.length} patches, ${nodes} flattened nodes, ${params} published params to ${out}`,
);
