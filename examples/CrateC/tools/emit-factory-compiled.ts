/**
 * Writes the factory library as compiled plugin documents, for `cratepack`.
 *
 * Each entry is `buildPluginDocument(patch).compiled`: the flattened graph,
 * its published parameters and its polyphony, which is the artifact the iOS
 * AUv3 plays. Building the device pack from the same call means the pedal
 * plays the graph the phone plays, not a second lowering of the patch.
 *
 *   node tools/emit-factory-compiled.mjs build/factory-compiled.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FACTORY_CATEGORY_ORDER, FACTORY_PATCHES } from '../../../editor/src/factoryPatches';
import { buildPluginDocument, suggestedRole } from '../../../editor/src/pluginDoc';

const out = process.argv[2];
if (!out) throw new Error('usage: emit-factory-compiled <output path>');

const entries = FACTORY_PATCHES.map((entry) => {
  const role = suggestedRole(entry.patch);
  const doc = buildPluginDocument(entry.patch, entry.name, role);
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    blurb: entry.blurb,
    slot: entry.slot,
    compiled: doc.compiled,
  };
});

mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify({ version: 1, categoryOrder: FACTORY_CATEGORY_ORDER, patches: entries });
writeFileSync(out, json);
console.log(`wrote ${entries.length} compiled factory patches (${(json.length / 1024).toFixed(1)} KB) to ${out}`);
