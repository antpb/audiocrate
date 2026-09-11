import { describe, expect, it } from 'vitest';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import { FUZZ_CURVE_LATENCY_SAMPLES, FUZZ_ASSET_KEY, fuzzPlugin } from '../../src/testing/testPlugin';
import { parametricEqMaterial } from '../../src/materials/parametricEq';
import {
  PDC_SCHEDULE_AHEAD_SEC,
  chainLatencySamples,
  pdcAudibleOriginSec,
  pdcStartDelaySec,
} from '../../src/host/pdc';

const SR = 48000;
// A convolver-sized partition, the shape a real latency-reporting insert has.
const IR_LATENCY_SAMPLES = 512;

describe('pdcStartDelaySec', () => {
  it('starts the wettest track immediately and holds dry tracks by the difference', () => {
    expect(pdcStartDelaySec(IR_LATENCY_SAMPLES, IR_LATENCY_SAMPLES, SR)).toBe(0);
    expect(pdcStartDelaySec(0, IR_LATENCY_SAMPLES, SR)).toBeCloseTo(512 / SR);
  });

  it('is zero when nothing reports latency', () => {
    expect(pdcStartDelaySec(0, 0, SR)).toBe(0);
  });
});

describe('pdcAudibleOriginSec', () => {
  it('adds master latency on top of the per-track max', () => {
    expect(pdcAudibleOriginSec(512, 512, SR)).toBeCloseTo(1024 / SR);
    expect(pdcAudibleOriginSec(512, 0, SR)).toBeCloseTo(512 / SR);
  });
});

describe('chainLatencySamples', () => {
  const registry = new AudioMaterialRegistry().register(fuzzPlugin);

  it('asks each AudioMaterial\'s own plugin rather than knowing any latency itself', () => {
    const quiet = fuzzPlugin.create();
    const latent = fuzzPlugin.create();
    latent.setAsset(FUZZ_ASSET_KEY, { filename: 'c.wav', samples: new Float32Array(1), sampleRate: SR });

    expect(chainLatencySamples([quiet], registry)).toBe(0);
    expect(chainLatencySamples([latent], registry)).toBe(FUZZ_CURVE_LATENCY_SAMPLES);
    expect(chainLatencySamples([latent, latent], registry)).toBe(FUZZ_CURVE_LATENCY_SAMPLES * 2);
  });

  it('reports zero for a pure ASL AudioMaterial, which is sample-for-sample', () => {
    expect(chainLatencySamples([parametricEqMaterial], registry)).toBe(0);
  });
});

describe('one schedule origin', () => {
  it('keeps relative PDC when every start is offset from the same origin', () => {
    const origin = 12.5;
    const dry = origin + PDC_SCHEDULE_AHEAD_SEC + pdcStartDelaySec(0, 512, SR);
    const wet = origin + PDC_SCHEDULE_AHEAD_SEC + pdcStartDelaySec(512, 512, SR);
    expect(dry - wet).toBeCloseTo(512 / SR);
  });
});
