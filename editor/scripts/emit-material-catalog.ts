/**
 * Writes the material catalog a native patcher draws its palette from.
 *
 * Same split as the ASL, MIDI and tempo emitters: the value is built by
 * `editor/src/materialCatalog.ts`, so a test can rebuild it and notice when
 * the file on disk no longer matches the code. This is only the part that
 * needs a filesystem.
 *
 * The output goes straight into the Swift package that ships it. There is
 * deliberately no second copy under `fixtures/`: the Swift tests read the
 * shipped file, so the thing under test is the thing that ships.
 *
 *   npm run fixtures:materials
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildMaterialCatalog } from '../src/materialCatalog';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-material-catalog.mjs <output path>');

const fixture = buildMaterialCatalog();
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(fixture, null, 0);
writeFileSync(out, json);

console.log(
  `wrote ${fixture.materials.length} materials, ${fixture.tools.length} tools, ` +
    `${fixture.kernels.length} kernels (${(json.length / 1024).toFixed(1)} KB) to ${out}`,
);
