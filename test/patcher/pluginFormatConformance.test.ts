/**
 * `crate.plugin` format 2: shared nodes written once, read back as one node.
 *
 * Is `fixtures/plugin-format-conformance.json` still a description of this
 * code, and does this reader do what it asks of every other reader?
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildPluginFormatFixture,
  pluginFormatStamp,
  type PluginFormatFixture,
} from '../../src/patcher/pluginFormatConformance';
import {
  CRATE_PLUGIN_MAX_VERSION,
  parseCratePlugin,
  stringifyCratePlugin,
} from '../../src/patcher/cratePlugin';
import { inflateSerializedGraph, shareSerializedGraph, type SerializedGraph } from '../../src/patcher/compiledPlugin';
import { compileVoice } from '../../src/asl/compile';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/plugin-format-conformance.json', import.meta.url));
const REGENERATE = 'npm run fixtures:plugin-format (from web-version/)';

function renderParsed(text: string, entry: PluginFormatFixture['cases'][number], fixture: PluginFormatFixture) {
  const doc = parseCratePlugin(text);
  const voice = compileVoice(doc.compiled!.graph as never);
  const state = voice.createState();
  voice.noteOn(state, entry.params);
  const input = Float32Array.from(fixture.input);
  const inputR = input.map((x) => -x);
  const out = new Float32Array(fixture.frames);
  const outR = new Float32Array(fixture.frames);
  const left: number[] = [];
  for (let b = 0; b < fixture.blocks; b++) {
    voice.renderBlock(state, fixture.sampleRate, out, entry.role === 'insert' ? input : undefined, {
      inputR: entry.role === 'insert' ? inputR : undefined,
      outputR: outR,
    });
    left.push(...out);
  }
  return left;
}

describe('plugin format conformance fixture', () => {
  const onDisk = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PluginFormatFixture;
  const rebuilt = buildPluginFormatFixture();

  it('is not stale', () => {
    expect(onDisk.stamp, `fixtures/plugin-format-conformance.json is stale. Regenerate it: ${REGENERATE}`).toBe(
      rebuilt.stamp,
    );
  });

  it('is self-consistent, so a hand-edited fixture is refused', () => {
    expect(pluginFormatStamp(onDisk)).toBe(onDisk.stamp);
  });

  it('has cases that share, sound, and are all distinct', () => {
    expect(onDisk.cases.some((entry) => entry.v2Nodes < entry.v1Nodes / 2)).toBe(true);
    for (const entry of onDisk.cases) {
      const peak = entry.left.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      expect(peak, `${entry.name} renders silence, which asserts nothing`).toBeGreaterThan(1e-3);
    }
    expect(new Set(onDisk.cases.map((entry) => JSON.stringify(entry.left))).size).toBe(onDisk.cases.length);
  });

  it.each(onDisk.cases.map((entry) => [entry.name, entry] as const))(
    '%s: both formats render what was recorded, to the bit',
    (_name, entry) => {
      // `===` per sample, not toEqual: JSON cannot carry the sign of zero, so
      // a recorded -0 comes back as 0 and toEqual would call that a mismatch.
      const agrees = (rendered: number[]) =>
        rendered.length === entry.left.length && rendered.every((x, i) => x === entry.left[i]);
      expect(agrees(renderParsed(entry.v1, entry, onDisk)), 'format 1').toBe(true);
      expect(agrees(renderParsed(entry.v2, entry, onDisk)), 'format 2').toBe(true);
    },
  );
});

describe('format 2 reading and writing', () => {
  const graph = (output: unknown): SerializedGraph => ({ inputs: [], output: output as never });

  it('reads a shared node back as one object reached twice', () => {
    const shared = { id: 2, kind: 'const', params: { value: 1 }, inputs: {} };
    const written = shareSerializedGraph(graph({ id: 1, kind: 'add', params: {}, inputs: { a: shared, b: shared } }));
    expect(written.output.inputs.b).toEqual({ ref: 2 });
    const read = inflateSerializedGraph(written);
    expect(read.output.inputs.a).toBe(read.output.inputs.b);
  });

  it('folds the repeated copies in a format 1 file into one object too', () => {
    const copy = () => ({ id: 2, kind: 'const', params: { value: 1 }, inputs: {} });
    const read = inflateSerializedGraph(graph({ id: 1, kind: 'add', params: {}, inputs: { a: copy(), b: copy() } }));
    expect(read.output.inputs.a).toBe(read.output.inputs.b);
  });

  it('refuses a reference to a node it never defines', () => {
    expect(() => inflateSerializedGraph(graph({ id: 1, kind: 'add', params: {}, inputs: { a: { ref: 9 } } }))).toThrow(
      /never defines/,
    );
  });

  it('refuses a node that is its own input', () => {
    expect(() => inflateSerializedGraph(graph({ id: 1, kind: 'mul', params: {}, inputs: { a: { ref: 1 } } }))).toThrow(
      /its own input/,
    );
  });

  it('refuses a format newer than it reads, and says what to do', () => {
    const text = JSON.stringify({ version: CRATE_PLUGIN_MAX_VERSION + 1, kind: 'crate.plugin' });
    expect(() => parseCratePlugin(text)).toThrow(/newer audiocrate.*Update audiocrate/);
  });

  it('writes format 1 unless asked, so hosts that read only 1 keep working', () => {
    const [entry] = buildPluginFormatFixture().cases;
    expect(JSON.parse(entry!.v1).version).toBe(1);
    expect(entry!.v1).not.toContain('"ref"');
    expect(JSON.parse(entry!.v2).version).toBe(2);
    // And writing a parsed format 2 document out again without sharing is a
    // valid format 1 graph under a format 2 header: refs are allowed, not required.
    const again = stringifyCratePlugin(parseCratePlugin(entry!.v2));
    expect(again).not.toContain('"ref"');
  });
});
