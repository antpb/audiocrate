/**
 * Writes the conformance fixture a second ASL interpreter is checked against.
 *
 * The interesting part moved to `src/asl/conformanceFixture.ts`, so that
 * `conformanceFixture.test.ts` can rebuild the fixture and notice when the
 * file on disk no longer matches the code. This is now only the part that
 * needs a filesystem, which is the part a test should not do.
 *
 *   npm run fixtures:asl
 *
 * or by hand, from `packages/crate`:
 *
 *   npx esbuild scripts/emit-asl-fixtures.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/emit.mjs \
 *   && node /tmp/emit.mjs fixtures/asl-conformance.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildConformanceFixture } from '../src/asl/conformanceFixture';

// Given on the command line, because this is run from a bundle in a temp
// directory and `import.meta.url` would resolve against that instead of the
// package.
const out = process.argv[2];
if (!out) throw new Error('usage: node emit-asl-fixtures.mjs <output path>');

const fixture = buildConformanceFixture();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 0));

const stereo = fixture.cases.filter((entry) => entry.firstR !== undefined).length;
console.log(
  `wrote ${fixture.cases.length} cases (${stereo} stereo) covering ` +
    `${fixture.kinds.length} node kinds to ${out}\nstamp ${fixture.stamp}`,
);
