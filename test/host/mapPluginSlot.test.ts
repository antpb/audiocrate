import { beforeEach, describe, expect, it } from 'vitest';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import {
  FUZZ_SUBTYPE,
  TEST_MANUFACTURER,
  TONE_SUBTYPE,
  fuzzPlugin,
  tonePlugin,
  type DecodedFuzzPreset,
} from '../../src/testing/testPlugin';
import { AU_TYPE_EFFECT, AU_TYPE_INSTRUMENT } from '../../src/host/pluginSlots';
import { mapPluginSlot } from '../../src/host/mapPluginSlot';

function jsonBlob(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

// Deliberately a private registry with plugins crate does not ship. If these
// pass, the mapping path has no hidden knowledge of any particular plugin.
let registry: AudioMaterialRegistry;

beforeEach(() => {
  registry = new AudioMaterialRegistry().registerAll([fuzzPlugin, tonePlugin]);
});

describe('mapPluginSlot', () => {
  it('skips an empty slot', () => {
    expect(mapPluginSlot(null, null, registry)).toEqual({ bound: false, kind: 'skip', reason: 'empty' });
  });

  it('skips a plugin nothing claims, without throwing', () => {
    const mapped = mapPluginSlot(
      { componentType: AU_TYPE_EFFECT, componentSubType: 0x64726d73, componentManufacturer: TEST_MANUFACTURER },
      null,
      registry,
    );
    expect(mapped).toEqual({ bound: false, kind: 'skip', reason: 'unknown', subtype: 0x64726d73 });
  });

  it('binds a registered insert plugin and applies its preset', () => {
    const mapped = mapPluginSlot(
      { componentType: AU_TYPE_EFFECT, componentSubType: FUZZ_SUBTYPE, componentManufacturer: TEST_MANUFACTURER },
      jsonBlob({ param_0: 1.25, curveFilename: 'bright.wav' }),
      registry,
    );
    expect(mapped.kind).toBe('test.fuzz');
    if (!mapped.bound) return;
    expect(mapped.role).toBe('insert');
    expect(mapped.material.kind).toBe('test.fuzz');
    expect(mapped.material.getParam('drive')).toBeCloseTo(1.25);
    expect((mapped.preset as DecodedFuzzPreset).curveFilename).toBe('bright.wav');
  });

  it('reports an instrument plugin as instrument, not insert', () => {
    const mapped = mapPluginSlot(
      { componentType: AU_TYPE_INSTRUMENT, componentSubType: TONE_SUBTYPE, componentManufacturer: TEST_MANUFACTURER },
      jsonBlob({ param_0: 0.75 }),
      registry,
    );
    expect(mapped.kind).toBe('test.tone');
    if (!mapped.bound) return;
    expect(mapped.role).toBe('instrument');
    expect(mapped.material.getParam('level')).toBeCloseTo(0.75);
  });

  it('keeps defaults when the blob is unreadable, rather than losing the slot', () => {
    const mapped = mapPluginSlot(
      { componentType: AU_TYPE_EFFECT, componentSubType: FUZZ_SUBTYPE, componentManufacturer: TEST_MANUFACTURER },
      'not-valid-base64-or-archive!!!',
      registry,
    );
    expect(mapped.kind).toBe('test.fuzz');
    if (!mapped.bound) return;
    expect(mapped.material.getParam('drive')).toBe(1);
  });

  it('does not match a plugin whose manufacturer differs', () => {
    const mapped = mapPluginSlot(
      { componentType: AU_TYPE_EFFECT, componentSubType: FUZZ_SUBTYPE, componentManufacturer: 0x4f544852 },
      null,
      registry,
    );
    expect(mapped.kind).toBe('skip');
  });

  it('binds the MIDI-effect type of the same subtype and manufacturer', () => {
    const mapped = mapPluginSlot(
      { componentType: 0x61756d66, componentSubType: FUZZ_SUBTYPE, componentManufacturer: TEST_MANUFACTURER },
      null,
      registry,
    );
    expect(mapped.kind).toBe('test.fuzz');
  });

  it('binds when the project left manufacturer as 0', () => {
    const mapped = mapPluginSlot(
      { componentType: AU_TYPE_EFFECT, componentSubType: FUZZ_SUBTYPE, componentManufacturer: 0 },
      null,
      registry,
    );
    expect(mapped.kind).toBe('test.fuzz');
  });

  it('refuses to register the reserved "skip" kind', () => {
    expect(() => registry.register({ ...fuzzPlugin, kind: 'skip' })).toThrow(RangeError);
  });

  it('unregistering makes a previously bound plugin skip again', () => {
    registry.unregister('test.fuzz');
    const mapped = mapPluginSlot(
      { componentType: AU_TYPE_EFFECT, componentSubType: FUZZ_SUBTYPE, componentManufacturer: TEST_MANUFACTURER },
      null,
      registry,
    );
    expect(mapped.kind).toBe('skip');
  });
});
