import { describe, expect, it } from 'vitest';
import { resampleChannel } from '../../src/clip/resample';
import { prepareClipBuffer } from '../src/resampleAudio';

function fakeCtx(sampleRate: number) {
  return {
    sampleRate,
    createBuffer: (channels: number, length: number, rate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        sampleRate: rate,
        length,
        duration: length / rate,
        numberOfChannels: channels,
        copyToChannel: (d: Float32Array, ch: number) => data[ch]!.set(d),
        getChannelData: (ch: number) => data[ch]!,
      };
    },
  } as unknown as AudioContext;
}

describe('prepareClipBuffer', () => {
  it('converts a 44.1k take to the opened 48k context without a playbackRate scale', () => {
    const samples = new Float32Array(44100);
    samples.fill(0.4);
    const prepared = prepareClipBuffer(fakeCtx(48000), { samples, sampleRate: 44100 });
    expect(prepared.rateScale).toBe(1);
    expect(prepared.buffer.sampleRate).toBe(48000);
    expect(prepared.buffer.duration).toBeCloseTo(1, 8);
  });

  it('keeps duration when lifting Fine 91 file rate to 48k', () => {
    const dest = resampleChannel(new Float32Array(3007620), 44100, 48000);
    expect(dest.length / 48000).toBeCloseTo(3007620 / 44100, 8);
  });
});
