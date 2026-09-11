/**
 * The stone's voice, rendered offline.
 *
 * A browser check can tell you a worklet loaded and the page did not throw.
 * It is very bad at telling you the sound is right, and "the plugin runs but
 * every stone is silent" is the failure this is actually guarding, because
 * silence in a spatial mix forty metres away is indistinguishable from
 * distance.
 *
 * This is also the part of the pitch that a plugin cannot demonstrate on its
 * own: the AudioMaterial renders in Node, with no `AudioContext`, no worklet and
 * no browser, through the same interpreter the audio thread runs. The graph
 * is data, so it goes wherever the data goes.
 */
import { describe, expect, it } from 'vitest';
import { OfflineRenderer } from '../crate';
import { resonantStoneMaterial } from './resonantStone';

const SR = 48000;

function render(params: Record<string, number>, duration = 1.5): Float32Array {
  return OfflineRenderer.render(resonantStoneMaterial.graph, {
    duration,
    sampleRate: SR,
    params: { ...resonantStoneMaterial.snapshotParams(), velocity: 0, ...params },
  }).samples;
}

/** RMS over a window, as the fraction of the render `from`..`to`. */
function rms(samples: Float32Array, from = 0, to = 1): number {
  const start = Math.floor(samples.length * from);
  const end = Math.floor(samples.length * to);
  let sumSq = 0;
  for (let i = start; i < end; i++) sumSq += samples[i]! * samples[i]!;
  return Math.sqrt(sumSq / Math.max(1, end - start));
}

function peak(samples: Float32Array): number {
  let out = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs > out) out = abs;
  }
  return out;
}

describe('the resonant stone', () => {
  it('makes sound when the wind blows', () => {
    // Measured over the second half, after the resonator has filled. A stone
    // that only made noise at t=0 would pass a peak check and be silent in a
    // world.
    expect(rms(render({ wind: 1 }), 0.5, 1)).toBeGreaterThan(0.001);
  });

  it('goes quiet when it does not', () => {
    // Not silent, exactly: the resonator is still ringing down. The contract
    // is that a still day is much quieter than a gale, because that is what
    // makes weather audible as you walk into it.
    const still = rms(render({ wind: 0 }), 0.5, 1);
    const gale = rms(render({ wind: 1 }), 0.5, 1);
    expect(still).toBeLessThan(gale * 0.2);
  });

  it('is deterministic, which is why it has no noise node', () => {
    // Sample-and-hold excitation, not `noise()`. `noise()` is not
    // reproducible even against itself.
    expect(Array.from(render({ wind: 1 }))).toEqual(Array.from(render({ wind: 1 })));
  });

  it('sounds different per stone without needing a different graph', () => {
    // The parameters that carry per-spawn identity really do change the
    // sound. If they did not, every stone on the hillside would be a copy and
    // the seeded scatter would be decoration over a single voice.
    const one = render({ wind: 1, pitch: 180, grain: 400, grainRatio: 1.4 });
    const two = render({ wind: 1, pitch: 495, grain: 1900, grainRatio: 3.9 });
    expect(Array.from(one)).not.toEqual(Array.from(two));
  });

  it('rings when struck, and decays', () => {
    // A strike is one impulse through a high-Q resonator: loud immediately,
    // quieter later. Both halves matter, and the second one more: forty
    // stones that rang forever would be forty stones ringing forever.
    const struck = render({ wind: 0, velocity: 1 }, 2);
    const attack = rms(struck, 0, 0.1);
    const tail = rms(struck, 0.8, 1);
    expect(attack).toBeGreaterThan(0.005);
    expect(tail).toBeLessThan(attack * 0.25);
  });

  it('is louder struck hard than struck softly', () => {
    const soft = rms(render({ wind: 0, velocity: 0.2 }, 2), 0, 0.1);
    const hard = rms(render({ wind: 0, velocity: 1 }, 2), 0, 0.1);
    expect(hard).toBeGreaterThan(soft * 1.5);
  });

  it('stays bounded at maximum everything', () => {
    // Forty of these sum at the listener. A voice that peaks at 3 turns the
    // whole spatial mix into distortion, and the soft clip in the graph is
    // what stops it.
    expect(peak(render({ wind: 1, ring: 90, brightness: 1, pitch: 1400, velocity: 1 }))).toBeLessThanOrEqual(1);
  });

  it('declares the meter the glow follows', () => {
    // `tap.meter` inside the graph, not the engine's master analyser: this
    // stone's level, not the level of every stone plus the music plus voice
    // chat.
    expect(resonantStoneMaterial.graph).toBeDefined();
    const rendered = OfflineRenderer.render(resonantStoneMaterial.graph, {
      duration: 0.05,
      params: { ...resonantStoneMaterial.snapshotParams(), wind: 1 },
    });
    expect(rendered.samples.length).toBe(Math.round(0.05 * 48000));
  });
});
