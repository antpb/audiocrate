/**
 * The rule that keeps B-format cables away from ordinary audio ones.
 *
 * This is worth a test rather than a comment because both mistakes it
 * prevents are silent. B-format into the mixer folds four channels into a
 * phasey stereo pair that sounds like a broken effect rather than a wiring
 * error. Ordinary audio into a spatial master is read as a field whose W, Y,
 * Z and X are all the same signal, which decodes to a source wedged in one
 * corner and stuck there.
 */
import { describe, expect, it } from 'vitest';
import { catalog, catalogEntry, categories } from '../src/catalog';
import { nodeInputs, nodeOutputs } from '../src/controlInputs';
import {
  isBformatPort,
  isSpatialKind,
  isSpatialMasterKind,
  isSpatialSourceKind,
} from '../src/spatialNodes';

describe('the spatial palette entries', () => {
  it('are both present under Spatial', () => {
    expect(categories()).toContain('Spatial');
    expect(catalogEntry('spatialsource')?.category).toBe('Spatial');
    expect(catalogEntry('spatialmaster')?.category).toBe('Spatial');
  });

  it('are Materials, so their positions can be edited, automated and saved', () => {
    // The alternative would be tools like `master`, which carry no param
    // descriptors and so could not expose x/y/z at all.
    expect(catalogEntry('spatialsource')?.create).toBeTypeOf('function');
    expect(catalogEntry('spatialmaster')?.create).toBeTypeOf('function');
  });

  it('gives a source CV inlets for every position axis', () => {
    const material = catalogEntry('spatialsource')!.create!();
    const inputs = nodeInputs(material);
    for (const axis of ['x', 'y', 'z']) expect(inputs, axis).toContain(axis);
    expect(inputs).toContain('input');
  });

  it('gives a master a listener orientation it can be automated on', () => {
    const material = catalogEntry('spatialmaster')!.create!();
    expect(material.automatable).toContain('yaw');
    expect(material.automatable).toContain('pitch');
  });
});

describe('isBformatPort', () => {
  it('marks a source outlet and a master inlet, and nothing else on them', () => {
    expect(isBformatPort('spatialsource', 'output', 'audio')).toBe(true);
    expect(isBformatPort('spatialsource', 'input', 'input')).toBe(false);
    expect(isBformatPort('spatialmaster', 'input', 'input')).toBe(true);
    expect(isBformatPort('spatialmaster', 'output', 'audio')).toBe(false);
  });

  it('leaves the position inlets as ordinary CV', () => {
    // These take an LFO. Typing them as B-format would refuse the one cable
    // the whole design exists to allow.
    for (const axis of ['x', 'y', 'z', 'gain']) {
      expect(isBformatPort('spatialsource', 'input', axis), axis).toBe(false);
    }
  });

  it('marks no port on any other kind in the palette', () => {
    for (const entry of catalog) {
      if (isSpatialKind(entry.kind)) continue;
      // Plugin entries resolve through the registry, which is empty here.
      // Their ports still have to be checked, so fall back to the names any
      // node might use rather than skipping them.
      let material;
      try {
        material = entry.create?.();
      } catch {
        material = undefined;
      }
      const inputs = material
        ? nodeInputs(material)
        : (entry.inputs ?? ['input', 'audio', 'cv', 'note', 'gate']);
      const outputs = material ? nodeOutputs(material) : (entry.outputs ?? ['audio', 'cv']);
      for (const name of inputs) {
        expect(isBformatPort(entry.kind, 'input', name), `${entry.kind}.${name}`).toBe(false);
      }
      for (const name of outputs) {
        expect(isBformatPort(entry.kind, 'output', name), `${entry.kind}.${name}`).toBe(false);
      }
    }
  });
});

/** The predicate `PatchEditor.socketsMatch` applies, without needing a DOM. */
const compatible = (
  sourceKind: string,
  sourceOutput: string,
  targetKind: string,
  targetInput: string,
): boolean =>
  isBformatPort(sourceKind, 'output', sourceOutput) === isBformatPort(targetKind, 'input', targetInput);

describe('which cables are allowed', () => {
  it('allows a source into a master', () => {
    expect(compatible('spatialsource', 'audio', 'spatialmaster', 'input')).toBe(true);
  });

  it('allows a master into the mixer', () => {
    expect(compatible('spatialmaster', 'audio', 'master', 'input')).toBe(true);
    expect(compatible('spatialmaster', 'audio', 'gain', 'input')).toBe(true);
  });

  it('allows ordinary audio into a source', () => {
    expect(compatible('oscillator', 'audio', 'spatialsource', 'input')).toBe(true);
    expect(compatible('sampleplayer', 'audio', 'spatialsource', 'input')).toBe(true);
  });

  it('refuses a source straight into the mixer', () => {
    // The mistake a user makes first, every time.
    expect(compatible('spatialsource', 'audio', 'master', 'input')).toBe(false);
    expect(compatible('spatialsource', 'audio', 'gain', 'input')).toBe(false);
    expect(compatible('spatialsource', 'audio', 'lowpass', 'input')).toBe(false);
  });

  it('refuses ordinary audio into a master', () => {
    expect(compatible('oscillator', 'audio', 'spatialmaster', 'input')).toBe(false);
    expect(compatible('line', 'audio', 'spatialmaster', 'input')).toBe(false);
  });

  it('allows an LFO onto a position axis', () => {
    // The cable the feature is for.
    expect(compatible('lfo', 'cv', 'spatialsource', 'x')).toBe(true);
    expect(compatible('lfo', 'cv', 'spatialsource', 'z')).toBe(true);
  });
});

describe('kind predicates', () => {
  it('agree with each other', () => {
    expect(isSpatialSourceKind('spatialsource')).toBe(true);
    expect(isSpatialMasterKind('spatialmaster')).toBe(true);
    expect(isSpatialKind('spatialsource')).toBe(true);
    expect(isSpatialKind('spatialmaster')).toBe(true);
    expect(isSpatialKind('gain')).toBe(false);
    expect(isSpatialSourceKind('spatialmaster')).toBe(false);
  });
});
