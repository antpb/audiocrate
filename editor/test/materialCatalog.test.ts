import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildFlattenConformanceFixture } from '../src/flattenConformance';
import { buildMaterialCatalog } from '../src/materialCatalog';

const here = dirname(fileURLToPath(import.meta.url));

function checkedIn(path: string): unknown {
  return JSON.parse(readFileSync(resolve(here, path), 'utf8'));
}

/**
 * The two files the Swift patcher reads. Both are rebuilt in memory here and
 * compared against what is on disk, so a material added to the palette or a
 * rule changed in `flattenPatch` turns this red rather than reaching the
 * native side as a kind it has never heard of.
 *
 * This is the gate section 4.2 of `CRATE_IOS_HANDOFF.md` asks for, applied to
 * the palette instead of the node registry: a fixture a human remembers to
 * regenerate is a fixture that goes stale.
 */
describe('material catalog fixture', () => {
  it('matches the catalog the Swift package ships', () => {
    const rebuilt = buildMaterialCatalog();
    const onDisk = checkedIn('../../examples/CrateASL/Sources/CrateASL/Resources/material-catalog.json');
    expect(
      rebuilt,
      'material-catalog.json is stale: run `npm run fixtures:materials`',
    ).toEqual(onDisk);
  });

  it('declares jacks and param order that a native palette can trust', () => {
    const catalog = buildMaterialCatalog();
    for (const material of catalog.materials) {
      expect(Object.keys(material.params).sort(), material.kind).toEqual(
        [...material.paramOrder].sort(),
      );
      for (const port of material.audioInputs) {
        // An audio inlet a node does not draw is an inlet nobody can patch,
        // which is how a sidechain silently becomes unreachable.
        expect(material.inputs, `${material.kind}.${port}`).toContain(port);
      }
      expect(material.outputs.length, `${material.kind} has no outlet`).toBeGreaterThan(0);
    }
  });

  it('does not put a kernel in the runnable half', () => {
    const catalog = buildMaterialCatalog();
    const kinds = new Set(catalog.materials.map((entry) => entry.kind));
    for (const kernel of catalog.kernels) {
      expect(kinds.has(kernel.kind), `${kernel.kind} cannot be both`).toBe(false);
      expect(kernel.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('flatten conformance fixture', () => {
  it('matches the fixture the Swift tests read', () => {
    const rebuilt = buildFlattenConformanceFixture();
    const onDisk = checkedIn('../../fixtures/flatten-conformance.json');
    expect(
      rebuilt,
      'flatten-conformance.json is stale: run `npm run fixtures:flatten`',
    ).toEqual(onDisk);
  });

  it('states what each case proves', () => {
    for (const entry of buildFlattenConformanceFixture().cases) {
      expect(entry.proves.length, entry.name).toBeGreaterThan(20);
    }
  });

  it('carries cases whose values are not all defaults', () => {
    // A fixture whose gains are all 1 and whose cutoffs are all the material
    // default cannot tell a port that read the document from one that guessed
    // it: the wrong constant is the right answer. This asserts the cases
    // actually move the numbers.
    const fixture = buildFlattenConformanceFixture();
    const defaults = fixture.cases.flatMap((entry) =>
      Object.values(entry.expected.params).map((descriptor) => descriptor.default),
    );
    expect(defaults.some((value) => value !== 0 && value !== 1)).toBe(true);
    const ranges = fixture.cases.flatMap((entry) =>
      entry.expected.graph.nodes.filter((node) => node.kind === 'range'),
    );
    expect(ranges.length, 'no CV mapping is exercised').toBeGreaterThan(0);
  });
});
