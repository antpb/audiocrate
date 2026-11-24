/**
 * homecrate's crate AU, read from a project slot.
 *
 * The slot's saved state carries a compiled crate patch. What matters is that
 * the web builds the graph that was saved: so each case writes a real
 * material out the way the AU stores it, maps the slot, and renders both.
 */
import { describe, expect, it } from 'vitest';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { param } from '../../src/graph/param';
import { audio, filter } from '../../src/asl/builders';
import { compileVoice } from '../../src/asl/compile';
import { compileMaterial } from '../../src/patcher/compiledPlugin';
import { synthVoiceMaterial } from '../../src/materials/synthVoice';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import { mapPluginSlot } from '../../src/host/mapPluginSlot';
import { registerCoreMaterials } from '../../src/materials/core';
import { AU_TYPE_EFFECT, AU_TYPE_INSTRUMENT } from '../../src/host/pluginSlots';
import {
  HOMECRATE_CRATE_MANUFACTURER,
  HOMECRATE_CRATE_SUBTYPE,
  decodeNativeCratePreset,
  materialFromCompiled,
} from '../../src/patcher/nativeCrate';

const SR = 48000;

function crateAu(componentType: number) {
  return {
    componentType,
    componentSubType: HOMECRATE_CRATE_SUBTYPE,
    componentManufacturer: HOMECRATE_CRATE_MANUFACTURER,
    componentName: componentType === AU_TYPE_INSTRUMENT ? 'hc_crate (Instrument)' : 'hc_crate',
  };
}

/** The AU's saved state, as JSON (`decodePresetBlob` reads JSON as well as a keyed archive). */
function presetBlob(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(fields)).toString('base64');
}

function render(material: AudioMaterial, frames: number, input?: Float32Array, note?: Record<string, number>): Float32Array {
  const voice = compileVoice(material.graph);
  const state = voice.createState();
  for (const [key, value] of Object.entries(material.snapshotParams())) state.params[key] = value;
  voice.noteOn(state, note ?? {});
  const out = new Float32Array(frames);
  for (let b = 0; b < 3; b++) voice.renderBlock(state, SR, out, input, {});
  return out;
}

function tone(frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * 180 * i) / SR) * 0.5;
  return out;
}

// One filter read twice: the rebuilt graph must keep it one node.
const crusher = new AudioMaterial({
  name: 'Bitcrusher',
  params: {
    lp_cutoff: { ...param.range(80, 12000, { default: 2000, unit: 'Hz', curve: 'log' }), address: 0 },
    lvl_gain: { ...param.range(0, 2, { default: 1 }), address: 1 },
  },
  graph: ({ params }) => {
    const lp = filter.lowpass(audio.input(), { cutoff: params.lp_cutoff });
    return lp.add(lp.mul(0.25)).mul(params.lvl_gain);
  },
});

describe('the crate AU', () => {
  const registry = registerCoreMaterials(new AudioMaterialRegistry());

  it('maps the instrument and the effect to their own plugins by component type', () => {
    expect(registry.matchHost(crateAu(AU_TYPE_INSTRUMENT))?.role).toBe('instrument');
    expect(registry.matchHost(crateAu(AU_TYPE_EFFECT))?.role).toBe('insert');
  });

  it('builds an effect from its compiled graph and applies param_N by address', () => {
    const compiled = compileMaterial(crusher, 'insert');
    const blob = presetBlob({
      crateCompiledGraph: JSON.stringify(compiled),
      cratePluginLabel: 'Bitcrusher',
      param_0: 600,
      param_1: 0.5,
    });
    const mapped = mapPluginSlot(crateAu(AU_TYPE_EFFECT), blob, registry);
    expect(mapped.bound).toBe(true);
    if (!mapped.bound) return;
    expect(mapped.role).toBe('insert');
    expect(mapped.material.name).toBe('Bitcrusher');
    expect(mapped.material.getParam('lp_cutoff')).toBe(600);
    expect(mapped.material.getParam('lvl_gain')).toBe(0.5);

    const reference = crusher.duplicate();
    reference.setParam('lp_cutoff', 600);
    reference.setParam('lvl_gain', 0.5);
    const input = tone(256);
    const expected = render(reference, 256, input);
    expect(expected.some((v) => v !== 0)).toBe(true);
    expect(Array.from(render(mapped.material, 256, input))).toEqual(Array.from(expected));
  });

  it('builds an instrument that plays notes, with its polyphony', () => {
    const compiled = compileMaterial(synthVoiceMaterial, 'instrument', synthVoiceMaterial.polyphony);
    const blob = presetBlob({ crateCompiledGraph: JSON.stringify(compiled), cratePluginLabel: 'Pad' });
    const mapped = mapPluginSlot(crateAu(AU_TYPE_INSTRUMENT), blob, registry);
    expect(mapped.bound).toBe(true);
    if (!mapped.bound) return;
    expect(mapped.role).toBe('instrument');
    expect(mapped.material.polyphony).toBe(synthVoiceMaterial.polyphony);
    const note = { note: 60, velocity: 1, gate: 1 };
    const expected = render(synthVoiceMaterial, 512, undefined, note);
    expect(expected.some((v) => v !== 0)).toBe(true);
    expect(Array.from(render(mapped.material, 512, undefined, note))).toEqual(Array.from(expected));
  });

  it('keeps shared nodes shared and gives every node a fresh id', () => {
    const compiled = JSON.parse(JSON.stringify(compileMaterial(crusher, 'insert')));
    const a = materialFromCompiled(compiled, { kind: 'homecrate.crate-fx' });
    const b = materialFromCompiled(compiled, { kind: 'homecrate.crate-fx' });
    const ids = (m: AudioMaterial) => {
      const seen = new Set<number>();
      let visits = 0;
      const walk = (node: { id: number; inputs: Record<string, never>; list?: never[] }) => {
        visits++;
        if (seen.has(node.id)) return;
        seen.add(node.id);
        Object.values(node.inputs).forEach(walk);
        node.list?.forEach(walk);
      };
      walk(m.graph.output as never);
      return { seen, visits };
    };
    const ia = ids(a);
    const ib = ids(b);
    expect(ia.visits).toBeGreaterThan(ia.seen.size); // the filter is reached twice, built once
    expect([...ia.seen].some((id) => ib.seen.has(id))).toBe(false);
  });

  it('an empty or unreadable crate stays bound: silent as an instrument, a wire as an effect', () => {
    const inst = mapPluginSlot(crateAu(AU_TYPE_INSTRUMENT), null, registry);
    expect(inst.bound).toBe(true);
    const fx = mapPluginSlot(crateAu(AU_TYPE_EFFECT), presetBlob({ crateCompiledGraph: '{"broken":' }), registry);
    expect(fx.bound).toBe(true);
    if (!fx.bound || !inst.bound) return;
    const input = tone(128);
    expect(Array.from(render(fx.material, 128, input))).toEqual(Array.from(input));
    expect(render(inst.material, 128, undefined, { note: 60, velocity: 1, gate: 1 }).every((v) => v === 0)).toBe(true);
  });

  it('decodes the saved state without a schema it does not have', () => {
    expect(decodeNativeCratePreset(presetBlob({ cratePluginLabel: 'Empty' }))).toMatchObject({ compiled: null, label: 'Empty' });
  });
});
