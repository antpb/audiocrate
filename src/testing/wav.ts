/**
 * Minimal 32-bit float PCM WAV codec, used only by the render-diff harness
 * (renderDiff.ts) to read/write golden fixtures. Float32 rather than int16
 * so a fixture round-trip never introduces its own quantization noise on
 * top of whatever tolerance a test is actually trying to measure. Node-only
 * (Buffer), matching testing's CI-only scope.
 */
export interface WavFile {
  samples: Float32Array;
  sampleRate: number;
}

const FORMAT_IEEE_FLOAT = 3;
const BITS_PER_SAMPLE = 32;
const NUM_CHANNELS = 1;

export function encodeWavFloat32({ samples, sampleRate }: WavFile): Buffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(FORMAT_IEEE_FLOAT, 20);
  buffer.writeUInt16LE(NUM_CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * NUM_CHANNELS * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(NUM_CHANNELS * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeFloatLE(samples[i]!, 44 + i * bytesPerSample);
  }

  return buffer;
}

export function decodeWavFloat32(buffer: Buffer): WavFile {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new TypeError('decodeWavFloat32: not a RIFF/WAVE file');
  }

  let offset = 12;
  let sampleRate: number | null = null;
  let formatTag: number | null = null;
  let bitsPerSample: number | null = null;
  let numChannels: number | null = null;
  let samples: Float32Array | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      formatTag = buffer.readUInt16LE(chunkStart);
      numChannels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      if (formatTag !== FORMAT_IEEE_FLOAT || bitsPerSample !== BITS_PER_SAMPLE || numChannels !== NUM_CHANNELS) {
        throw new TypeError('decodeWavFloat32: only mono 32-bit float WAV fixtures are supported');
      }
      const count = chunkSize / 4;
      samples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        samples[i] = buffer.readFloatLE(chunkStart + i * 4);
      }
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!samples || sampleRate === null) {
    throw new TypeError('decodeWavFloat32: missing fmt or data chunk');
  }

  return { samples, sampleRate };
}
