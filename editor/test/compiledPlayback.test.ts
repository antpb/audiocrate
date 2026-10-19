import { describe, expect, it } from 'vitest';
import { compiledParamName, compiledPlan, compiledStructureKey } from '../src/compiledPlayback';
import { FACTORY_PATCHES, factoryPatchById } from '../src/factoryPatches';
import { PATCH_KIND, type CratePatch } from '../src/patch';

/**
 * Which patches the browser plays as the plugin does (one flattened voice),
 * and which stay per module. The factory library is the case that matters:
 * those are the patches that have to sound the same in the browser and on
 * the phone.
 */
describe('compiled playback', () => {
  it('plays every factory patch compiled, so the browser sounds like the plugin', () => {
    const refused: string[] = [];
    for (const entry of FACTORY_PATCHES) {
      // The factory Wavetable is on its factory frames: no loaded file.
      const plan = compiledPlan(entry.patch, { holdsFile: () => false });
      if (!plan.ok) refused.push(`${entry.id}: ${plan.reason}`);
    }
    expect(refused).toEqual([]);
  });

  it('files the voice under the role the plugin slot would: instruments take keys, inserts are held open', () => {
    const acid = compiledPlan(factoryPatchById('acid-line')!.patch);
    const wah = compiledPlan(factoryPatchById('auto-wah')!.patch);
    const euclid = compiledPlan(factoryPatchById('euclid-bass')!.patch);
    expect(acid.ok && acid.role).toBe('instrument');
    expect(wah.ok && wah.role).toBe('insert');
    expect(euclid.ok && euclid.role).toBe('insert');
  });

  it('publishes each module parameter under the name setParam sends', () => {
    const plan = compiledPlan(factoryPatchById('wobble-bass')!.patch);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.material.params).toHaveProperty(compiledParamName('lad', 'resonance'));
    expect(plan.material.params).toHaveProperty(compiledParamName('lfo', 'rate'));
  });

  const patch = (nodes: CratePatch['nodes'], connections: CratePatch['connections']): CratePatch => ({
    version: 1,
    kind: PATCH_KIND,
    nodes,
    connections,
  });
  const n = (id: string, kind: string, params: Record<string, number> = {}) => ({ id, kind, x: 1, y: 1, params });
  const w = (source: string, target: string, targetInput = 'input') => ({
    source,
    sourceOutput: 'audio',
    target,
    targetInput,
  });

  it('keeps per module what compiling would take away, and says why', () => {
    const looper = compiledPlan(patch([n('line', 'line'), n('l', 'looper'), n('m', 'master')], [w('line', 'l'), w('l', 'm')]));
    expect(looper).toMatchObject({ ok: false, kind: 'ineligible' });
    const sample = compiledPlan(patch([n('s', 'sampleplayer'), n('m', 'master')], [w('s', 'm')]));
    expect(sample).toMatchObject({ ok: false, kind: 'ineligible' });
    const loadedTable = compiledPlan(patch([n('t', 'wavetable'), n('m', 'master')], [w('t', 'm')]), {
      holdsFile: () => true,
    });
    expect(loadedTable).toMatchObject({ ok: false, kind: 'ineligible' });
  });

  it('tells a patch mid-edit apart from one that cannot compile, so a running voice keeps playing', () => {
    const nothingReachesMaster = compiledPlan(patch([n('o', 'tone'), n('m', 'master')], []));
    expect(nothingReachesMaster).toMatchObject({ ok: false, kind: 'unflattenable' });
  });

  it('rebuilds on a module or a cable, never on a value or a position', () => {
    const base = factoryPatchById('reese')!.patch;
    const turned: CratePatch = {
      ...base,
      nodes: base.nodes.map((node) => (node.id === 'lp' ? { ...node, x: node.x + 50, params: { ...node.params, cutoff: 300 } } : node)),
    };
    expect(compiledStructureKey(turned)).toBe(compiledStructureKey(base));
    const recabled: CratePatch = { ...base, connections: base.connections.slice(1) };
    expect(compiledStructureKey(recabled)).not.toBe(compiledStructureKey(base));
  });
});
