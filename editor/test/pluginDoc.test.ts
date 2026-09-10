import { describe, expect, it } from 'vitest';
import { materialRegistry, parseCratePlugin, stringifyCratePlugin } from '../../src/index';
import { catalogEntry } from '../src/catalog';
import { starterPatch } from '../src/patch';
import { buildPluginDocument, registerPluginDocument, suggestedRole } from '../src/pluginDoc';

describe('patch to plugin', () => {
  it('exports the starter patch as a polyphonic instrument and re-registers it', () => {
    const patch = starterPatch();
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
    const doc = buildPluginDocument(starterPatch(), 'Starter Synth', 'instrument');
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
    const patch = starterPatch();
    patch.connections = patch.connections.filter((conn) => conn.target !== 'master');
    expect(() => buildPluginDocument(patch, 'Broken', 'instrument')).toThrow(/master/);
  });
});
