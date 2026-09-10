/**
 * The compiled form has to survive JSON and still be the same graph.
 *
 * It exists so a host with no patcher in it (a Swift AUv3) can load a
 * `crate.plugin`. That host has exactly one way to find out the serializer
 * dropped something, which is that the plugin sounds wrong on a phone and
 * right in a browser. So the round trip is asserted here, by rendering both
 * and comparing samples, rather than by checking that some fields are
 * present.
 */
import { describe, expect, it } from 'vitest';
import { Material } from '../../src/graph/Material';
import { param } from '../../src/graph/param';
import { audio, filter, uniform, wavetable } from '../../src/asl/builders';
import { compileVoice } from '../../src/asl/compile';
import { ASL } from '../../src/asl/graph';
import { compileCratePlugin, compileMaterial, serializeGraph } from '../../src/patcher/compiledPlugin';
import { cratePluginDocument } from '../../src/patcher/cratePlugin';
import { flattenPatch, type PatchDocument } from '../../src/patcher/flattenPatch';

const SR = 48000;

function render(
  graph: Parameters<typeof compileVoice>[0],
  frames: number,
  input?: Float32Array,
  params: Record<string, number> = { gain: 0.6, cutoff: 900 },
): Float32Array {
  const voice = compileVoice(graph);
  const state = voice.createState();
  for (const [key, value] of Object.entries(params)) state.params[key] = value;
  voice.noteOn(state, {});
  const out = new Float32Array(frames);
  let outR: Float32Array | undefined;
  for (let b = 0; b < 3; b++) voice.renderBlock(state, SR, out, input, { outputR: outR });
  return out;
}

function tone(frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * 180 * i) / SR) * 0.5;
  return out;
}

describe('serializeGraph', () => {
  it('round-trips through JSON and renders the same samples', () => {
    const graph = ASL.node(({ cutoff, gain }) =>
      filter.lowpass(audio.input(), { cutoff, q: uniform(1.4) }).mul(gain),
    );
    const input = tone(256);

    const direct = render(graph, 256, input);
    const revived = JSON.parse(JSON.stringify(serializeGraph(graph)));
    const viaJson = render(revived, 256, input);

    expect(Array.from(viaJson)).toEqual(Array.from(direct));
  });

  it('turns a typed-array wavetable into something JSON can carry', () => {
    const table = Float32Array.from({ length: 8 }, (_, i) => Math.sin((i / 8) * Math.PI * 2));
    const graph = ASL.node(({ note }) => wavetable({ freq: note.toFrequency(), table }));

    const text = JSON.stringify(serializeGraph(graph));
    // A Float32Array survives JSON.stringify as `{"0":...}`, which decodes on
    // the other side as an object with no length and reads as an empty table.
    expect(text).not.toContain('"0":');

    const revived = JSON.parse(text);
    expect(Array.from(render(revived, 64))).toEqual(Array.from(render(graph, 64)));
  });

  it('keeps a shared node shared, by id', () => {
    // A diamond: one source read twice. The document writes it out twice and
    // the ids are what say it is one node. If a decoder misses that, the
    // source gets two pieces of state.
    const graph = ASL.node(() => {
      const source = audio.input();
      return source.add(source);
    });
    const serialized = serializeGraph(graph);
    const left = (serialized.output.inputs.a as { id: number }).id;
    const right = (serialized.output.inputs.b as { id: number }).id;
    expect(left).toBe(right);
  });
});

describe('compileCratePlugin', () => {
  const gainProto = new Material({
    name: 'Gain',
    kind: 'test.gain',
    params: { gain: param.range(0, 4, { default: 1, address: 7 }) },
    automatable: ['gain'],
    graph: ({ input, params }) => input.mul(params.gain),
  });

  const patch: PatchDocument = {
    nodes: [
      { id: 'in', kind: 'line' },
      { id: 'g', kind: 'test.gain' },
      { id: 'out', kind: 'master' },
    ],
    connections: [
      { source: 'in', sourceOutput: 'audio', target: 'g', targetInput: 'input' },
      { source: 'g', sourceOutput: 'audio', target: 'out', targetInput: 'input' },
    ],
  };

  const options = { resolve: (kind: string) => (kind === 'test.gain' ? gainProto : null) };

  it('carries the parameter schema a host builds its parameter tree from', () => {
    const doc = cratePluginDocument({ label: 'Test Gain', role: 'insert', patch });
    const compiled = compileCratePlugin(doc, options);

    expect(compiled.role).toBe('insert');
    expect(compiled.ports).toContain('input');
    const published = Object.values(compiled.params);
    expect(published.length).toBeGreaterThan(0);
    // Addresses are the whole reason the schema travels with the graph: they
    // are the AUParameterAddress on the other side. Flattening reassigns them
    // sequentially rather than carrying the inner Material's own, because two
    // copies of the same node would otherwise claim the same address. Every
    // published param has one, and no two share.
    const addresses = published.map((descriptor) => descriptor.address);
    expect(addresses.every((address) => typeof address === 'number')).toBe(true);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('is the same graph the browser path builds', () => {
    const doc = cratePluginDocument({ label: 'Test Gain', role: 'insert', patch });
    const compiled = compileCratePlugin(doc, options);
    // What a browser runs: flatten the patch and use the Material's graph.
    const live = flattenPatch(doc.patch, {
      resolve: options.resolve,
      name: doc.label,
      kind: doc.id,
      role: doc.role,
    });

    // Flattening prefixes a published param with its node id, so the values
    // come from the schema rather than from names guessed here. That the
    // schema is enough to drive the graph is the property a native host
    // depends on.
    const values: Record<string, number> = {};
    for (const [name, descriptor] of Object.entries(compiled.params)) values[name] = descriptor.default;

    const input = tone(128);
    const viaCompiled = render(JSON.parse(JSON.stringify(compiled.graph)), 128, input, values);
    const viaFlatten = render(live.graph, 128, input, values);

    expect(viaCompiled.some((v) => v !== 0)).toBe(true);
    expect(Array.from(viaCompiled)).toEqual(Array.from(viaFlatten));
  });
});
