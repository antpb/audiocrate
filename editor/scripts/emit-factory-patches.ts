/**
 * Writes the factory patch library the iOS plugin loads.
 *
 * Same split as the material catalog emitter: the value is built by
 * `buildFactoryCatalog` in `editor/src/factoryPatches.ts`, so a test can
 * rebuild it and notice when the file on disk no longer matches. The output
 * goes straight into the Swift package that ships it.
 *
 *   npm run fixtures:factory
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFactoryCatalog } from '../src/factoryPatches';

const out = process.argv[2];
if (!out) throw new Error('usage: node emit-factory-patches.mjs <output path>');

const catalog = buildFactoryCatalog();
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(catalog, null, 0);
writeFileSync(out, json);
console.log(`wrote ${catalog.patches.length} factory patches (${(json.length / 1024).toFixed(1)} KB) to ${out}`);
