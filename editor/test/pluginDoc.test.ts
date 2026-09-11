import { describe, expect, it } from 'vitest';
import { materialRegistry, parseCratePlugin, stringifyCratePlugin } from '../../src/index';
import { catalogEntry } from '../src/catalog';
import { PATCH_KIND, PATCH_VERSION, type CratePatch } from '../src/patch';
import { buildPluginDocument, registerPluginDocument, suggestedRole } from '../src/pluginDoc';

/** Flattenable subtractive voice. Amp in the editor starter cannot flatten. */
function instrumentPatch(): CratePatch {
  return {
    version: PATCH_VERSION,
    kind: PATCH_KIND,
    transport: { bpm: 120, beatsPerBar: 4, beatUnit: 4 },
    nodes: [
      { id: 'transport', kind: 'transport', x: 36, y: 36, params: { bpm: 120, beatsPerBar: 4, beatUnit: 4 } },
      { id: 'keys', kind: 'keyboard', x: 36, y: 340, params: {} },
      { id: 'osc', kind: 'oscillator', x: 280, y: 36, params: { gain: 0.35, width: 0.5 } },
      { id: 'adsr', kind: 'adsr', x: 280, y: 280, params: { attack: 0.02, decay: 0.22, sustain: 0.28, release: 0.45, amount: 0.85 } },
      { id: 'lfo', kind: 'lfo', x: 280, y: 520, params: { rate: 0.55, amount: 0.4 } },
      { id: 'lp', kind: 'lowpass', x: 560, y: 160, params: { cutoff: 800, q: 0.9 } },
      { id: 'delay', kind: 'delay', x: 800, y: 160, params: { timeSec: 0.22, feedback: 0.28, mix: 0.22 } },
      { id: 'master', kind: 'master', x: 1040, y: 160, params: {} },
    ],
    connections: [
      { source: 'keys', sourceOutput: 'cv', target: 'osc', targetInput: 'note' },
      { source: 'keys', sourceOutput: 'gate', target: 'osc', targetInput: 'gate' },
      { source: 'keys', sourceOutput: 'cv', target: 'adsr', targetInput: 'note' },
      { source: 'keys', sourceOutput: 'gate', target: 'adsr', targetInput: 'gate' },
      { source: 'osc', sourceOutput: 'audio', target: 'lp', targetInput: 'input' },
      { source: 'adsr', sourceOutput: 'cv', target: 'lp', targetInput: 'cutoff' },
      { source: 'lfo', sourceOutput: 'cv', target: 'osc', targetInput: 'width' },
      { source: 'lp', sourceOutput: 'audio', target: 'delay', targetInput: 'input' },
      { source: 'delay', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
    ],
  };
}

describe('patch to plugin', () => {
  it('exports a subtractive instrument as a polyphonic plugin and re-registers it', () => {
    const patch = instrumentPatch();
    expect(suggestedRole(patch)).toBe('instrument');

    const doc = buildPluginDocument(patch, 'Starter Synth', 'instrument');
    expect(doc.kind).toBe('crate.plugin');
    expect(doc.id).toBe('user.starter-synth');
    expect(doc.patch.nodes.map((node) => node.kind)).toEqual([
      'transport',
      'keyboard',
      'oscillator',
      'adsr',
      'lfo',
      'lowpass',
      'delay',
      'master',
    ]);

    const back = parseCratePlugin(stringifyCratePlugin(doc));
    registerPluginDocument(back);

    const plugin = materialRegistry.get('user.starter-synth');
    expect(plugin?.role).toBe('instrument');
    const material = plugin!.create();
    expect(material.polyphony).toBe(8);
    expect(Object.keys(material.params)).toContain('osc_gain');
    expect(Object.keys(material.params)).not.toContain('lp_cutoff');
    expect(catalogEntry('user.starter-synth')?.label).toBe('Starter Synth');
  });

  it('carries a compiled graph a host without a patcher can run', () => {
    // A crate.plugin is a patch, and the ASL graph is produced from it by
    // `flattenPatch` in JavaScript. A Swift AUv3 has no patcher in it, so
    // export writes the flattened result alongside the patch. Without this
    // the AUv3 importer has nothing to import.
    const doc = buildPluginDocument(instrumentPatch(), 'Starter Synth', 'instrument');
    const compiled = doc.compiled;
    expect(compiled).toBeDefined();
    expect(compiled!.role).toBe('instrument');
    expect(compiled!.graph.output).toBeDefined();

    // Every published parameter has a distinct address, which is what the
    // other side builds an AUParameterTree from.
    const addresses = Object.values(compiled!.params).map((d) => d.address);
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((a) => typeof a === 'number')).toBe(true);
    expect(new Set(addresses).size).toBe(addresses.length);

    // And it survives the round trip the file actually takes.
    const back = parseCratePlugin(stringifyCratePlugin(doc));
    expect(back.compiled?.graph).toEqual(compiled!.graph);
    expect(Object.keys(back.compiled!.params)).toEqual(Object.keys(compiled!.params));
  });

  it('refuses to export a patch whose output is unwired', () => {
    const patch = instrumentPatch();
    patch.connections = patch.connections.filter((conn) => conn.target !== 'master');
    expect(() => buildPluginDocument(patch, 'Broken', 'instrument')).toThrow(/master/);
  });
});
