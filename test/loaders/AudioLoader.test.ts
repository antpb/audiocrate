import { describe, expect, it } from 'vitest';
import { AudioLoader, decodeCaf, decodeWav, decodeAudioFile } from '../../src/loaders/AudioLoader';

/** Builds a real-shaped WAV: RIFF/WAVE, an optional JUNK padding chunk before
 * `fmt ` (homecrate's own exports always include one), then fmt + data. */
function buildWav(options: {
  channels: number;
  sampleRate: number;
  formatTag: 1 | 3; // 1 = int PCM, 3 = IEEE float
  bitsPerSample: 16 | 32;
  frames: number[][]; // one array of per-channel samples (-1..1) per frame
  includeJunk?: boolean;
}): Uint8Array {
  const { channels, sampleRate, formatTag, bitsPerSample, frames, includeJunk = false } = options;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = frames.length * channels * bytesPerSample;

  const parts: Buffer[] = [];

  if (includeJunk) {
    const junkPayloadSize = 28;
    const junk = Buffer.alloc(8 + junkPayloadSize);
    junk.write('JUNK', 0, 'ascii');
    junk.writeUInt32LE(junkPayloadSize, 4);
    parts.push(junk);
  }

  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(formatTag, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 16);
  fmt.writeUInt16LE(channels * bytesPerSample, 20);
  fmt.writeUInt16LE(bitsPerSample, 22);
  parts.push(fmt);

  const data = Buffer.alloc(8 + dataBytes);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(dataBytes, 4);
  let off = 8;
  for (const frame of frames) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = frame[ch]!;
      if (formatTag === 3) {
        data.writeFloatLE(sample, off);
        off += 4;
      } else {
        data.writeInt16LE(Math.round(sample * 32768), off);
        off += 2;
      }
    }
  }
  parts.push(data);

  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return new Uint8Array(Buffer.concat([riff, body]));
}

/** Builds a real-shaped CAF: caff/desc/data, linear PCM float32, matching
 * homecrate's own `*_slice_*.caf` warp-render output exactly (including the
 * 4-byte mEditCount field at the start of `data`'s payload). */
function buildCaf(options: { channels: number; sampleRate: number; littleEndian: boolean; frames: number[][] }): Uint8Array {
  const { channels, sampleRate, littleEndian, frames } = options;
  const bytesPerPacket = 4 * channels;
  const sampleBytes = frames.length * bytesPerPacket;

  const header = Buffer.alloc(8);
  header.write('caff', 0, 'ascii');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);

  const desc = Buffer.alloc(12 + 32);
  desc.write('desc', 0, 'ascii');
  desc.writeUInt32BE(0, 4);
  desc.writeUInt32BE(32, 8);
  desc.writeDoubleBE(sampleRate, 12);
  desc.write('lpcm', 20, 'ascii');
  const flags = 1 /* float */ | (littleEndian ? 2 : 0);
  desc.writeUInt32BE(flags, 24);
  desc.writeUInt32BE(bytesPerPacket, 28);
  desc.writeUInt32BE(1, 32); // framesPerPacket
  desc.writeUInt32BE(channels, 36);
  desc.writeUInt32BE(32, 40); // bitsPerChannel

  const dataPayloadSize = 4 + sampleBytes; // 4-byte edit count + samples
  const dataChunk = Buffer.alloc(12 + dataPayloadSize);
  dataChunk.write('data', 0, 'ascii');
  dataChunk.writeUInt32BE(0, 4);
  dataChunk.writeUInt32BE(dataPayloadSize, 8);
  dataChunk.writeUInt32BE(1, 12); // mEditCount
  let off = 16;
  for (const frame of frames) {
    for (let ch = 0; ch < channels; ch++) {
      if (littleEndian) dataChunk.writeFloatLE(frame[ch]!, off);
      else dataChunk.writeFloatBE(frame[ch]!, off);
      off += 4;
    }
  }

  return new Uint8Array(Buffer.concat([header, desc, dataChunk]));
}

describe('decodeWav', () => {
  it('decodes float32 stereo, including a JUNK chunk before fmt (real homecrate exports always have one)', () => {
    const frames = [
      [0.5, -0.5],
      [1, -1],
      [0, 0.25],
    ];
    const bytes = buildWav({ channels: 2, sampleRate: 44100, formatTag: 3, bitsPerSample: 32, frames, includeJunk: true });
    const buffer = decodeWav(bytes);

    expect(buffer.sampleRate).toBe(44100);
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.length).toBe(3);
    expect(Array.from(buffer.getChannelData(0))).toEqual([0.5, 1, 0]);
    expect(Array.from(buffer.getChannelData(1))).toEqual([-0.5, -1, 0.25]);
  });

  it('decodes 16-bit int PCM mono', () => {
    const frames = [[0.5], [-0.5], [0]];
    const bytes = buildWav({ channels: 1, sampleRate: 48000, formatTag: 1, bitsPerSample: 16, frames });
    const buffer = decodeWav(bytes);

    expect(buffer.numberOfChannels).toBe(1);
    expect(buffer.getChannelData(0)[0]).toBeCloseTo(0.5, 3);
    expect(buffer.getChannelData(0)[1]).toBeCloseTo(-0.5, 3);
    expect(buffer.getChannelData(0)[2]).toBeCloseTo(0, 3);
  });

  it('rejects a non-RIFF buffer', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow(TypeError);
  });

  it('decodes WAVEFORMATEXTENSIBLE IEEE float', () => {
    const frames = [[0.25], [-0.5]];
    const dataBytes = frames.length * 4;
    const fmt = Buffer.alloc(8 + 40);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(40, 4);
    fmt.writeUInt16LE(0xfffe, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(48000, 12);
    fmt.writeUInt32LE(48000 * 4, 16);
    fmt.writeUInt16LE(4, 20);
    fmt.writeUInt16LE(32, 22);
    fmt.writeUInt16LE(22, 24);
    fmt.writeUInt16LE(32, 26);
    fmt.writeUInt32LE(4, 28);
    fmt.writeUInt32LE(3, 32);
    fmt.write('fmt ', 36, 'ascii');
    const data = Buffer.alloc(8 + dataBytes);
    data.write('data', 0, 'ascii');
    data.writeUInt32LE(dataBytes, 4);
    data.writeFloatLE(0.25, 8);
    data.writeFloatLE(-0.5, 12);
    const body = Buffer.concat([fmt, data]);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + body.length, 4);
    riff.write('WAVE', 8, 'ascii');
    const buffer = decodeWav(new Uint8Array(Buffer.concat([riff, body])));
    expect(buffer.sampleRate).toBe(48000);
    expect(buffer.getChannelData(0)[0]).toBeCloseTo(0.25);
    expect(buffer.getChannelData(0)[1]).toBeCloseTo(-0.5);
  });

  it('decodes 24-bit integer PCM', () => {
    const frames = [[0.5], [-0.5]];
    const dataBytes = frames.length * 3;
    const fmt = Buffer.alloc(8 + 16);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(44100, 12);
    fmt.writeUInt32LE(44100 * 3, 16);
    fmt.writeUInt16LE(3, 20);
    fmt.writeUInt16LE(24, 22);
    const data = Buffer.alloc(8 + dataBytes);
    data.write('data', 0, 'ascii');
    data.writeUInt32LE(dataBytes, 4);
    const pos = Math.round(0.5 * 8388608);
    const neg = Math.round(-0.5 * 8388608) & 0xffffff;
    data.writeUInt8(pos & 0xff, 8);
    data.writeUInt8((pos >> 8) & 0xff, 9);
    data.writeUInt8((pos >> 16) & 0xff, 10);
    data.writeUInt8(neg & 0xff, 11);
    data.writeUInt8((neg >> 8) & 0xff, 12);
    data.writeUInt8((neg >> 16) & 0xff, 13);
    const body = Buffer.concat([fmt, data]);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + body.length, 4);
    riff.write('WAVE', 8, 'ascii');
    const buffer = decodeWav(new Uint8Array(Buffer.concat([riff, body])));
    expect(buffer.getChannelData(0)[0]).toBeCloseTo(0.5, 3);
    expect(buffer.getChannelData(0)[1]).toBeCloseTo(-0.5, 3);
  });
});

describe('decodeCaf', () => {
  it('decodes little-endian float32 stereo (matches a real homecrate warp-render .caf)', () => {
    const frames = [
      [0.1, -0.1],
      [0.2, -0.2],
    ];
    const bytes = buildCaf({ channels: 2, sampleRate: 44100, littleEndian: true, frames });
    const buffer = decodeCaf(bytes);

    expect(buffer.sampleRate).toBe(44100);
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.length).toBe(2);
    expect(Array.from(buffer.getChannelData(0))).toEqual([0.1, 0.2].map((v) => Math.fround(v)));
    expect(Array.from(buffer.getChannelData(1))).toEqual([-0.1, -0.2].map((v) => Math.fround(v)));
  });

  it('decodes big-endian float32 too (formatFlags without the little-endian bit)', () => {
    const frames = [[0.3], [-0.3]];
    const bytes = buildCaf({ channels: 1, sampleRate: 48000, littleEndian: false, frames });
    const buffer = decodeCaf(bytes);
    expect(Array.from(buffer.getChannelData(0))).toEqual([0.3, -0.3].map((v) => Math.fround(v)));
  });

  it('rejects a non-CAF buffer', () => {
    expect(() => decodeCaf(new Uint8Array([1, 2, 3, 4]))).toThrow(TypeError);
  });
});

describe('decodeAudioFile / AudioLoader', () => {
  it('dispatches by extension', () => {
    const wavBytes = buildWav({ channels: 1, sampleRate: 44100, formatTag: 3, bitsPerSample: 32, frames: [[0.5]] });
    const cafBytes = buildCaf({ channels: 1, sampleRate: 44100, littleEndian: true, frames: [[0.5]] });

    expect(decodeAudioFile(wavBytes, 'take.wav').numberOfChannels).toBe(1);
    expect(decodeAudioFile(cafBytes, 'take_slice_123.caf').numberOfChannels).toBe(1);
    expect(AudioLoader.decode(wavBytes, 'TAKE.WAV').sampleRate).toBe(44100); // case-insensitive
  });

  it('rejects an unsupported extension', () => {
    expect(() => decodeAudioFile(new Uint8Array(4), 'take.mp3')).toThrow(/unsupported file extension/);
  });

  it('decodes a file-time region without reading the rest', () => {
    const frames = [[0.1], [0.2], [0.3], [0.4]];
    const bytes = buildWav({ channels: 1, sampleRate: 2, formatTag: 3, bitsPerSample: 32, frames });
    const slice = decodeAudioFile(bytes, 'take.wav', { startSec: 1, endSec: 3 });
    expect(slice.length).toBe(2);
    expect(Array.from(slice.getChannelData(0))).toEqual([0.3, 0.4].map((v) => Math.fround(v)));
  });
});
