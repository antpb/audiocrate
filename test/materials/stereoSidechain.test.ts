import { describe, expect, it } from 'vitest';
import {
  balanceMaterial,
  channelSwapMaterial,
  haasMaterial,
  midSideDecodeMaterial,
  midSideEncodeMaterial,
  monoSumMaterial,
  stereoMergeMaterial,
  stereoPanMaterial,
  stereoWidthMaterial,
} from '../../src/materials/stereo';
import {
  audioMixMaterial,
  audioMultiplyMaterial,
  crossfadeMaterial,
  duckerMaterial,
  inputSelectMaterial,
  sidechainGateMaterial,
} from '../../src/materials/sidechain';
import { compileVoice } from '../../src/asl/compile';
import type { Material } from '../../src/graph/Material';

const SR = 48000;

interface RenderOptions {
  left: Float32Array;
  right?: Float32Array;
  sidechain?: Float32Array;
  params?: Record<string, number>;
}

/** Renders a Material as a stereo insert, the way a track actually runs one. */
function renderStereo(material: Material, options: RenderOptions): { left: Float32Array; right: Float32Array } {
  const voice = compileVoice(material.graph);
  const state = voice.createState();
  voice.noteOn(state, { ...material.snapshotParams(), ...options.params });
  const frames = options.left.length;
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  voice.renderBlock(state, SR, outL, options.left, {
    inputR: options.right,
    outputR: outR,
    ports: options.sidechain ? { sidechain: [options.sidechain] } : undefined,
  });
  return { left: outL, right: outR };
}

const filled = (length: number, value: number) => new Float32Array(length).fill(value);

describe('stereo Materials', () => {
  it('sums a correlated pair to the same level and cancels an anti-correlated one', () => {
    const same = renderStereo(monoSumMaterial, { left: filled(8, 0.5), right: filled(8, 0.5) });
    expect(same.left[0]).toBeCloseTo(0.5, 6);
    expect(same.right[0]).toBeCloseTo(0.5, 6);

    const opposed = renderStereo(monoSumMaterial, { left: filled(8, 0.5), right: filled(8, -0.5) });
    expect(opposed.left[0]).toBeCloseTo(0, 6);
  });

  it('swaps the channels', () => {
    const out = renderStereo(channelSwapMaterial, { left: filled(4, 1), right: filled(4, -1) });
    expect(out.left[0]).toBeCloseTo(-1, 6);
    expect(out.right[0]).toBeCloseTo(1, 6);
  });

  it('is exact bypass at width 1 and mono at width 0', () => {
    const unity = renderStereo(stereoWidthMaterial, {
      left: filled(4, 0.8),
      right: filled(4, 0.2),
      params: { width: 1 },
    });
    expect(unity.left[0]).toBeCloseTo(0.8, 6);
    expect(unity.right[0]).toBeCloseTo(0.2, 6);

    const collapsed = renderStereo(stereoWidthMaterial, {
      left: filled(4, 0.8),
      right: filled(4, 0.2),
      params: { width: 0 },
    });
    expect(collapsed.left[0]).toBeCloseTo(0.5, 6);
    expect(collapsed.right[0]).toBeCloseTo(0.5, 6);
  });

  it('round-trips through mid/side encode and decode', () => {
    const encoded = renderStereo(midSideEncodeMaterial, { left: filled(4, 0.9), right: filled(4, -0.3) });
    const decoded = renderStereo(midSideDecodeMaterial, { left: encoded.left, right: encoded.right });
    expect(decoded.left[0]).toBeCloseTo(0.9, 6);
    expect(decoded.right[0]).toBeCloseTo(-0.3, 6);
  });

  it('trims each side independently', () => {
    const out = renderStereo(balanceMaterial, {
      left: filled(4, 1),
      right: filled(4, 1),
      params: { left: 0.25, right: 1 },
    });
    expect(out.left[0]).toBeCloseTo(0.25, 6);
    expect(out.right[0]).toBeCloseTo(1, 6);
  });

  it('is identity at center and folds a silent side instead of muting it', () => {
    const centre = renderStereo(stereoPanMaterial, { left: filled(4, 1), right: filled(4, 0.4), params: { pan: 0 } });
    expect(centre.left[0]).toBeCloseTo(1, 5);
    expect(centre.right[0]).toBeCloseTo(0.4, 5);

    const hardLeft = renderStereo(stereoPanMaterial, { left: filled(4, 1), right: filled(4, 1), params: { pan: -1 } });
    expect(hardLeft.left[0]).toBeCloseTo(Math.SQRT2, 5);
    expect(hardLeft.right[0]).toBeCloseTo(0, 5);

    const leftOnlyRight = renderStereo(stereoPanMaterial, {
      left: filled(4, 1),
      right: filled(4, 0),
      params: { pan: 1 },
    });
    expect(leftOnlyRight.left[0]).toBeCloseTo(0, 5);
    expect(leftOnlyRight.right[0]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('delays only the right side for Haas widening', () => {
    const frames = 512;
    const click = new Float32Array(frames);
    click[0] = 1;
    const out = renderStereo(haasMaterial, { left: click, right: click, params: { delayMs: 10 } });
    expect(out.left[0]).toBeCloseTo(1, 5);
    expect(out.right[0]).toBeCloseTo(0, 5);
    const delayed = Math.round(0.01 * SR);
    expect(out.right[delayed]).toBeGreaterThan(0.5);
  });

  it('merges two mono signals into a pair', () => {
    const out = renderStereo(stereoMergeMaterial, { left: filled(4, 0.3), sidechain: filled(4, -0.7) });
    expect(out.left[0]).toBeCloseTo(0.3, 6);
    expect(out.right[0]).toBeCloseTo(-0.7, 6);
  });
});

describe('sidechain Materials', () => {
  it('ducks in proportion to the key signal', () => {
    const frames = 4096;
    const input = filled(frames, 0.5);
    const open = renderStereo(duckerMaterial, { left: input, sidechain: new Float32Array(frames) });
    const closed = renderStereo(duckerMaterial, { left: input, sidechain: filled(frames, 1) });
    expect(open.left[frames - 1]).toBeCloseTo(0.5, 3);
    expect(closed.left[frames - 1]!).toBeLessThan(0.15);
  });

  it('opens a gate only while the key is above threshold', () => {
    const frames = 4096;
    const input = filled(frames, 0.5);
    const shut = renderStereo(sidechainGateMaterial, { left: input, sidechain: new Float32Array(frames) });
    const open = renderStereo(sidechainGateMaterial, { left: input, sidechain: filled(frames, 1) });
    expect(shut.left[frames - 1]).toBe(0);
    expect(open.left[frames - 1]).toBeCloseTo(0.5, 5);
  });

  it('multiplies one signal by the other', () => {
    const out = renderStereo(audioMultiplyMaterial, {
      left: new Float32Array([1, 1, 1, 1]),
      sidechain: new Float32Array([0, 0.5, 1, -1]),
      params: { mix: 1 },
    });
    expect([...out.left]).toEqual([0, 0.5, 1, -1]);
  });

  it('leaves the signal alone at mix 0, which is what an unconnected send should sound like', () => {
    const out = renderStereo(audioMultiplyMaterial, {
      left: filled(4, 0.4),
      sidechain: new Float32Array(4),
      params: { mix: 0 },
    });
    expect(out.left[0]).toBeCloseTo(0.4, 6);
  });

  it('sums a second input at a level', () => {
    const out = renderStereo(audioMixMaterial, {
      left: filled(4, 0.2),
      sidechain: filled(4, 0.4),
      params: { level: 0.5 },
    });
    expect(out.left[0]).toBeCloseTo(0.4, 6);
  });

  it('crossfades equal-power between the two inputs', () => {
    const dry = renderStereo(crossfadeMaterial, {
      left: filled(4, 1),
      sidechain: filled(4, -1),
      params: { position: 0 },
    });
    expect(dry.left[0]).toBeCloseTo(1, 5);

    const wet = renderStereo(crossfadeMaterial, {
      left: filled(4, 1),
      sidechain: filled(4, -1),
      params: { position: 1 },
    });
    expect(wet.left[0]).toBeCloseTo(-1, 5);

    const middle = renderStereo(crossfadeMaterial, {
      left: filled(4, 1),
      sidechain: new Float32Array(4),
      params: { position: 0.5 },
    });
    expect(middle.left[0]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('switches hard between inputs', () => {
    const a = renderStereo(inputSelectMaterial, { left: filled(4, 1), sidechain: filled(4, -1), params: { which: 0 } });
    const b = renderStereo(inputSelectMaterial, { left: filled(4, 1), sidechain: filled(4, -1), params: { which: 1 } });
    expect(a.left[0]).toBeCloseTo(1, 6);
    expect(b.left[0]).toBeCloseTo(-1, 6);
  });

  it('declares its second input so a host knows to wire one', () => {
    expect(duckerMaterial.auxAudioInputs).toEqual(['sidechain']);
    expect(stereoMergeMaterial.auxAudioInputs).toEqual(['sidechain']);
    expect(monoSumMaterial.auxAudioInputs).toEqual([]);
  });
});
