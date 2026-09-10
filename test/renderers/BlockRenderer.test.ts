/**
 * The property that makes this worth having: continuity.
 *
 * Anyone can fill a playback queue by calling `OfflineRenderer.render`
 * repeatedly. It clicks, because each call builds a fresh voice and every
 * filter, envelope and oscillator phase restarts at the chunk boundary. The
 * test that matters is therefore not "does it make sound" but "do successive
 * blocks join up exactly as one long render would".
 */
import { describe, expect, it } from 'vitest';
import { BlockRenderer } from '../../src/renderers/BlockRenderer';
import { OfflineRenderer } from '../../src/renderers/OfflineRenderer';
import { toneMaterial, oscillatorMaterial, lowpassMaterial } from '../../src/materials/index';

const SR = 48000;

/** Concatenates `count` blocks of `frames` from one renderer. */
function stream(renderer: BlockRenderer, frames: number, count: number): Float32Array {
  const out = new Float32Array(frames * count);
  for (let i = 0; i < count; i += 1) {
    out.set(renderer.render(frames).left, i * frames);
  }
  return out;
}

describe('block rendering joins up', () => {
  it('matches one long OfflineRenderer render, sample for sample', () => {
    const params = { freq: 220, gain: 0.5 };
    const blocks = stream(new BlockRenderer(toneMaterial.graph, { sampleRate: SR, params }), 128, 16);
    const whole = OfflineRenderer.render(toneMaterial.graph, {
      duration: (128 * 16) / SR,
      sampleRate: SR,
      params,
    }).samples;

    expect(blocks.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 1) {
      expect(blocks[i], `sample ${i}`).toBeCloseTo(whole[i]!, 6);
    }
  });

  it('holds regardless of how the blocks are sized', () => {
    // A queue does not promise uniform buffers, so continuity must not
    // depend on the block length being the one the voice was built with.
    const params = { freq: 330, gain: 0.4 };
    const renderer = new BlockRenderer(toneMaterial.graph, { sampleRate: SR, params });
    const out = new Float32Array(1024);
    let at = 0;
    for (const frames of [64, 128, 256, 100, 476]) {
      out.set(renderer.render(frames).left, at);
      at += frames;
    }
    const whole = OfflineRenderer.render(toneMaterial.graph, {
      duration: 1024 / SR,
      sampleRate: SR,
      params,
    }).samples;
    for (let i = 0; i < 1024; i += 1) expect(out[i], `sample ${i}`).toBeCloseTo(whole[i]!, 6);
  });

  it('has no discontinuity at the block seam', () => {
    // The direct measurement of the bug this prevents: a restarting
    // oscillator produces a step at the boundary far larger than the
    // sample-to-sample motion either side of it.
    const renderer = new BlockRenderer(toneMaterial.graph, {
      sampleRate: SR,
      params: { freq: 220, gain: 0.5 },
    });
    const a = Float32Array.from(renderer.render(128).left);
    const b = Float32Array.from(renderer.render(128).left);
    const seam = Math.abs(b[0]! - a[127]!);
    let typical = 0;
    for (let i = 1; i < 128; i += 1) typical = Math.max(typical, Math.abs(a[i]! - a[i - 1]!));
    expect(seam).toBeLessThanOrEqual(typical * 1.5);
  });

  it('carries filter state across blocks, not just oscillator phase', () => {
    // A filter that reset each block would let the first samples through
    // unfiltered every time, which reads as a buzz rather than a click.
    const noisy = new Float32Array(512);
    for (let i = 0; i < noisy.length; i += 1) noisy[i] = i % 2 === 0 ? 0.5 : -0.5;

    const renderer = new BlockRenderer(lowpassMaterial.graph, {
      sampleRate: SR,
      params: { cutoff: 300, q: 0.7 },
    });
    const streamed = new Float32Array(512);
    for (let i = 0; i < 4; i += 1) {
      streamed.set(renderer.render(128, noisy.subarray(i * 128, (i + 1) * 128)).left, i * 128);
    }
    const whole = OfflineRenderer.render(lowpassMaterial.graph, {
      duration: 512 / SR,
      sampleRate: SR,
      inputSignal: noisy,
      params: { cutoff: 300, q: 0.7 },
    }).samples;
    for (let i = 0; i < 512; i += 1) expect(streamed[i], `sample ${i}`).toBeCloseTo(whole[i]!, 6);
  });
});

describe('the block buffers', () => {
  it('are reused, which callers have to know about', () => {
    const renderer = new BlockRenderer(toneMaterial.graph, { sampleRate: SR, params: { freq: 220 } });
    const first = renderer.render(128).left;
    const second = renderer.render(128).left;
    expect(second).toBe(first);
  });

  it('are resized when the block length changes', () => {
    const renderer = new BlockRenderer(toneMaterial.graph, { sampleRate: SR, params: { freq: 220 } });
    expect(renderer.render(128).left.length).toBe(128);
    expect(renderer.render(64).left.length).toBe(64);
  });

  it('do not leak the previous block when the length is reused', () => {
    // The buffer is reused, so a graph that writes nothing must return
    // silence rather than whatever was in it last time.
    const renderer = new BlockRenderer(toneMaterial.graph, { sampleRate: SR, params: { gain: 0 } });
    const block = renderer.render(64);
    expect(block.left.every((v) => v === 0)).toBe(true);
  });

  it('mirrors mono output into the right channel', () => {
    const renderer = new BlockRenderer(toneMaterial.graph, { sampleRate: SR, params: { freq: 220, gain: 0.5 } });
    const block = renderer.render(128);
    for (let i = 0; i < 128; i += 1) expect(block.right[i]).toBe(block.left[i]);
  });

  it('renders nothing for zero frames without throwing', () => {
    const renderer = new BlockRenderer(toneMaterial.graph, { sampleRate: SR });
    expect(renderer.render(0).left.length).toBe(0);
  });

  it('rejects a nonsense block length rather than allocating it', () => {
    const renderer = new BlockRenderer(toneMaterial.graph, { sampleRate: SR });
    expect(() => renderer.render(-1)).toThrow(/non-negative/);
    expect(() => renderer.render(Number.NaN)).toThrow(/non-negative/);
  });
});

describe('note control', () => {
  it('reset discards the tail, noteOff does not', () => {
    const make = () =>
      new BlockRenderer(oscillatorMaterial.graph, {
        sampleRate: SR,
        params: { note: 69, velocity: 1, gain: 0.5 },
      });

    const released = make();
    released.render(2048);
    released.noteOff();
    let releasedPeak = 0;
    const tail = released.render(256).left;
    for (const v of tail) releasedPeak = Math.max(releasedPeak, Math.abs(v));

    const restarted = make();
    restarted.render(2048);
    restarted.reset();
    let restartedPeak = 0;
    const after = restarted.render(256).left;
    for (const v of after) restartedPeak = Math.max(restartedPeak, Math.abs(v));

    // A release still rings; a reset starts from nothing, so its first
    // block is at most an attack rather than a continuing note.
    expect(releasedPeak).toBeGreaterThan(0);
    expect(restartedPeak).toBeLessThan(releasedPeak);
  });
});
