import { describe, expect, it } from 'vitest';
import { decodeWavFloat32, encodeWavFloat32 } from '../../src/testing/wav';

describe('WAV float32 codec', () => {
  it('round-trips samples and sample rate exactly (no int16 quantization)', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.123456, -0.987654]);
    const buffer = encodeWavFloat32({ samples, sampleRate: 44100 });
    const decoded = decodeWavFloat32(buffer);

    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.samples.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(decoded.samples[i]).toBe(samples[i]);
    }
  });

  it('round-trips an empty buffer', () => {
    const buffer = encodeWavFloat32({ samples: new Float32Array(0), sampleRate: 48000 });
    const decoded = decodeWavFloat32(buffer);
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.samples.length).toBe(0);
  });

  it('rejects a non-RIFF buffer', () => {
    expect(() => decodeWavFloat32(Buffer.from('not a wav file at all'))).toThrow(TypeError);
  });
});
