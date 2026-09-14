import { describe, expect, it } from 'vitest';
import { resampleAudioBufferLike, resampleChannel } from '../../src/clip/resample';
import type { AudioBufferLike } from '../../src/graph/Clip';

describe('resampleChannel', () => {
  it('keeps wall-clock duration when lifting 44.1k to 48k', () => {
    const src = new Float32Array(44100);
    src.fill(0.5);
    const dest = resampleChannel(src, 44100, 48000);
    expect(dest.length).toBe(48000);
    expect(dest.length / 48000).toBeCloseTo(src.length / 44100, 8);
    expect(dest[0]).toBeCloseTo(0.5, 5);
    expect(dest[24000]).toBeCloseTo(0.5, 5);
  });

  it('is a no-op when the rates already match', () => {
    const src = new Float32Array([1, 2, 3]);
    expect(resampleChannel(src, 48000, 48000)).toBe(src);
  });
});

describe('resampleAudioBufferLike', () => {
  it('stamps Fine 91-style stereo at the opened context rate', () => {
    const frames = 44100 * 2;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    left.fill(0.25);
    right.fill(-0.25);
    const buffer: AudioBufferLike = {
      sampleRate: 44100,
      length: frames,
      numberOfChannels: 2,
      getChannelData: (ch) => (ch === 0 ? left : right),
    };
    const out = resampleAudioBufferLike(buffer, 48000);
    expect(out.sampleRate).toBe(48000);
    expect(out.length / 48000).toBeCloseTo(frames / 44100, 8);
    expect(out.getChannelData(0)[0]).toBeCloseTo(0.25, 5);
    expect(out.getChannelData(1)[0]).toBeCloseTo(-0.25, 5);
  });
});
