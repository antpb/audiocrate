import { describe, expect, it } from 'vitest';
import {
  FACTORY_CATEGORY_ORDER,
  FACTORY_PATCHES,
  factoryPatchById,
  factoryPatchFits,
  groupedFactoryPatches,
} from '../src/factoryPatches';
import { applyPatchLayout } from '../src/patchLayout';
import { isCratePatch, PATCH_KIND } from '../src/patch';

describe('factory patches', () => {
  it('ships one unique document per id, grouped in the iOS category order', () => {
    const ids = FACTORY_PATCHES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FACTORY_PATCHES.length).toBe(100);
    expect(groupedFactoryPatches().map((section) => section.category)).toEqual(FACTORY_CATEGORY_ORDER);
  });

  it('opens every factory patch as an editable crate.patch', () => {
    for (const entry of FACTORY_PATCHES) {
      expect(isCratePatch(entry.patch)).toBe(true);
      expect(entry.patch.kind).toBe(PATCH_KIND);
      expect(entry.patch.nodes.some((node) => node.kind === 'master')).toBe(true);
      expect(entry.patch.nodes.every((node) => node.x > 0 && node.y > 0)).toBe(true);
    }
  });

  it('cables instruments from Keyboard and inserts from Line', () => {
    const acid = factoryPatchById('acid-line');
    expect(acid?.slot).toBe('instrument');
    expect(acid?.patch.nodes.some((node) => node.kind === 'keyboard')).toBe(true);
    expect(acid?.patch.connections.some((conn) => conn.source === 'keys' && conn.target === 'v')).toBe(true);

    const wah = factoryPatchById('auto-wah');
    expect(wah?.slot).toBe('effect');
    expect(wah?.patch.nodes.some((node) => node.kind === 'line')).toBe(true);
    expect(wah?.blurb).toMatch(/envelope follower/i);
  });

  it('offers self-playing patches in either slot', () => {
    const bloom = factoryPatchById('ambient-bloom');
    expect(bloom?.slot).toBe('either');
    expect(factoryPatchFits(bloom!, 'instrument')).toBe(true);
    expect(factoryPatchFits(bloom!, 'effect')).toBe(true);
    expect(groupedFactoryPatches('effect').some((section) => section.patches.some((entry) => entry.id === 'ambient-bloom'))).toBe(
      true,
    );
    expect(groupedFactoryPatches('instrument').some((section) => section.patches.some((entry) => entry.id === 'acid-line'))).toBe(
      true,
    );
    expect(groupedFactoryPatches('effect').some((section) => section.patches.some((entry) => entry.id === 'acid-line'))).toBe(
      false,
    );
  });

  it('puts a closed VCA on the audio path and cables the envelope into its gain', () => {
    const kick = factoryPatchById('kick');
    const hat = factoryPatchById('hi-hat');
    const snare = factoryPatchById('snare');
    expect(hat?.patch.nodes.find((node) => node.id === 'vca')?.params.gain).toBe(0);
    expect(snare?.patch.nodes.find((node) => node.id === 'nvca')?.params.gain).toBe(0);
    expect(snare?.patch.nodes.find((node) => node.id === 'tvca')?.params.gain).toBe(0);

    expect(
      hat?.patch.connections.some(
        (conn) => conn.source === 'hhmid' && conn.target === 'vca' && conn.targetInput === 'gain',
      ),
    ).toBe(true);

    expect(kick?.patch.nodes.find((node) => node.id === 'body')?.kind).toBe('oscillator');
    expect(kick?.patch.nodes.find((node) => node.id === 'knock')?.kind).toBe('oscillator');
    expect(kick?.patch.nodes.find((node) => node.id === 'beater')?.kind).toBe('oscillator');
    expect(
      kick?.patch.connections.some(
        (conn) => conn.source === 'keys' && conn.target === 'body' && conn.targetInput === 'note',
      ),
    ).toBe(true);
    expect(
      kick?.patch.connections.some(
        (conn) => conn.source === 'keys' && conn.target === 'body' && conn.targetInput === 'gate',
      ),
    ).toBe(true);
    expect(
      kick?.patch.connections.some((conn) => conn.source === 'beater' && conn.target === 'lvl'),
    ).toBe(true);

    const wobble = factoryPatchById('wobble-bass');
    const wobAmt = wobble?.patch.nodes.find((node) => node.id === 'wobamt');
    expect(wobAmt?.params.gain).toBeLessThan(0.5);
  });

  it('lays nodes out by graph depth, matching CratePatchLayout', () => {
    const laid = applyPatchLayout({
      version: 1,
      kind: PATCH_KIND,
      nodes: [
        { id: 'a', kind: 'tone', x: 0, y: 0, params: {} },
        { id: 'b', kind: 'gain', x: 0, y: 0, params: {} },
        { id: 'c', kind: 'master', x: 0, y: 0, params: {} },
      ],
      connections: [
        { source: 'a', sourceOutput: 'audio', target: 'b', targetInput: 'input' },
        { source: 'b', sourceOutput: 'audio', target: 'c', targetInput: 'input' },
      ],
    });
    expect(laid.nodes.map((node) => [node.id, node.x, node.y])).toEqual([
      ['a', 40, 40],
      ['b', 260, 40],
      ['c', 480, 40],
    ]);
  });
});
