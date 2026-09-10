import type { AudioBufferLike } from '../graph/Clip';

/**
 * Decodes an audio file into the `AudioBufferLike` a `Clip` wraps.
 * WAV and CAF containers carrying 16-bit signed integer or 32-bit float
 * linear PCM. WAVEFORMATEXTENSIBLE (0xFFFE) and 24-bit integer PCM are
 * also accepted.
 *
 * Takes already-read bytes rather than fetching a path itself, so the
 * same decoder works from a Node `readFile`, a browser `fetch`, or a
 * dropped `File`. `ProjectLoader` is what resolves a path.
 */

interface PcmLayout {
  sampleRate: number;
  channels: number;
  bitsPerChannel: number;
  isFloat: boolean;
  littleEndian: boolean;
  dataByteOffset: number;
  dataByteLength: number;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export interface DecodeAudioRegion {
  startSec?: number;
  endSec?: number;
}

function decodePcm(view: DataView, layout: PcmLayout, region?: DecodeAudioRegion): AudioBufferLike {
  const bytesPerSample = layout.bitsPerChannel / 8;
  const frameBytes = bytesPerSample * layout.channels;
  const totalFrames = Math.floor(layout.dataByteLength / frameBytes);
  let startFrame = 0;
  let endFrame = totalFrames;
  if (region?.startSec != null && region.startSec > 0) {
    startFrame = Math.min(totalFrames, Math.max(0, Math.floor(region.startSec * layout.sampleRate)));
  }
  if (region?.endSec != null && Number.isFinite(region.endSec)) {
    endFrame = Math.min(totalFrames, Math.max(startFrame, Math.ceil(region.endSec * layout.sampleRate)));
  }
  const frameCount = endFrame - startFrame;
  const channelData: Float32Array[] = Array.from({ length: layout.channels }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < layout.channels; ch++) {
      const byteOffset = layout.dataByteOffset + (startFrame + frame) * frameBytes + ch * bytesPerSample;
      let sample: number;
      if (layout.isFloat) {
        sample = view.getFloat32(byteOffset, layout.littleEndian);
      } else if (layout.bitsPerChannel === 16) {
        sample = view.getInt16(byteOffset, layout.littleEndian) / 32768;
      } else if (layout.bitsPerChannel === 24) {
        const b0 = view.getUint8(byteOffset);
        const b1 = view.getUint8(byteOffset + 1);
        const b2 = view.getUint8(byteOffset + 2);
        let raw = layout.littleEndian ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        if (raw & 0x800000) raw -= 0x1000000;
        sample = raw / 8388608;
      } else {
        throw new Error(
          `AudioLoader: unsupported PCM bit depth ${layout.bitsPerChannel} (only 16/24-bit signed integer and 32-bit float are supported)`,
        );
      }
      channelData[ch]![frame] = sample;
    }
  }

  return {
    sampleRate: layout.sampleRate,
    length: frameCount,
    numberOfChannels: layout.channels,
    getChannelData(channel: number): Float32Array {
      const data = channelData[channel];
      if (!data) throw new RangeError(`AudioLoader: no channel ${channel} (buffer has ${layout.channels})`);
      return data;
    },
  };
}

/**
 * Generic RIFF/WAVE chunk walker (real homecrate exports carry a `JUNK`
 * padding chunk before `fmt `, so this can't assume a fixed 44-byte header).
 * Supports format tag 1 (integer PCM, 16-bit) and 3 (IEEE float, 32-bit),
 * any channel count, always little-endian per the WAV spec itself.
 */
export function decodeWav(bytes: Uint8Array, region?: DecodeAudioRegion): AudioBufferLike {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new TypeError('decodeWav: not a RIFF/WAVE file');
  }

  let offset = 12;
  let fmt: { formatTag: number; channels: number; sampleRate: number; bitsPerSample: number; isFloat: boolean } | null =
    null;
  let dataByteOffset: number | null = null;
  let dataByteLength: number | null = null;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      const formatTag = view.getUint16(chunkStart, true);
      let isFloat = formatTag === 3;
      if (formatTag === 0xfffe) {
        // WAVEFORMATEXTENSIBLE: subFormat GUID starts 24 bytes into fmt.
        if (chunkSize < 40) {
          throw new TypeError('decodeWav: WAVEFORMATEXTENSIBLE fmt chunk is truncated');
        }
        const subFormat = view.getUint32(chunkStart + 24, true);
        if (subFormat !== 1 && subFormat !== 3) {
          throw new Error(
            `decodeWav: unsupported WAVEFORMATEXTENSIBLE subformat ${subFormat} (only PCM=1 and IEEE float=3 are supported)`,
          );
        }
        isFloat = subFormat === 3;
      } else if (formatTag !== 1 && formatTag !== 3) {
        throw new Error(
          `decodeWav: unsupported WAV format tag ${formatTag} (only PCM=1, IEEE float=3, and extensible=0xFFFE are supported)`,
        );
      }
      fmt = {
        formatTag,
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
        isFloat,
      };
    } else if (chunkId === 'data') {
      dataByteOffset = chunkStart;
      dataByteLength = chunkSize;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataByteOffset === null || dataByteLength === null) {
    throw new TypeError('decodeWav: missing fmt or data chunk');
  }

  return decodePcm(
    view,
    {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerChannel: fmt.bitsPerSample,
      isFloat: fmt.isFloat,
      littleEndian: true,
      dataByteOffset,
      dataByteLength,
    },
    region,
  );
}

const CAF_FLAG_IS_FLOAT = 1 << 0;
// Named for the *set* meaning, per CAFFile.h's own `kCAFLinearPCMFormatFlagIsLittleEndian`
// (the opposite sense from AudioStreamBasicDescription's IsBigEndian flag elsewhere in
// CoreAudio, confirmed against a homecrate-exported CAF: flags=3 (float + this bit
// set) only decodes to sane sample values when read little-endian).
const CAF_FLAG_IS_LITTLE_ENDIAN = 1 << 1;

/**
 * Minimal CAF (Core Audio Format) reader: enough of the container to read
 * homecrate's own time-stretch/warp render output (`*_slice_*.caf` files),
 * which is always linear PCM. Everything outside the sample data itself
 * (chunk sizes, the `desc` chunk's fields) is big-endian per the CAF spec;
 * only the PCM sample bytes' endianness is governed by `formatFlags`.
 */
export function decodeCaf(bytes: Uint8Array, region?: DecodeAudioRegion): AudioBufferLike {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== 'caff') {
    throw new TypeError('decodeCaf: not a CAF file');
  }

  let offset = 8; // 'caff' magic (4) + mFileVersion/mFileFlags (2+2)
  let desc: { sampleRate: number; formatID: string; formatFlags: number; channels: number; bitsPerChannel: number } | null =
    null;
  let dataByteOffset: number | null = null;
  let dataByteLength: number | null = null;

  while (offset + 12 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    // Chunk size is a signed 64-bit big-endian integer; real files never
    // approach 2^53, so read as two 32-bit halves and recombine as a Number.
    const sizeHigh = view.getUint32(offset + 4, false);
    const sizeLow = view.getUint32(offset + 8, false);
    const chunkSize = sizeHigh * 2 ** 32 + sizeLow;
    const chunkStart = offset + 12;

    if (chunkId === 'desc') {
      desc = {
        sampleRate: view.getFloat64(chunkStart, false),
        formatID: readAscii(view, chunkStart + 8, 4),
        formatFlags: view.getUint32(chunkStart + 12, false),
        // bytesPerPacket (@+16) and framesPerPacket (@+20) are unused: only
        // interleaved, one-frame-per-packet linear PCM is supported here.
        channels: view.getUint32(chunkStart + 24, false),
        bitsPerChannel: view.getUint32(chunkStart + 28, false),
      };
    } else if (chunkId === 'data') {
      // The first 4 bytes of a CAF 'data' chunk are always the mEditCount
      // field, never sample data.
      dataByteOffset = chunkStart + 4;
      dataByteLength = chunkSize - 4;
    }

    offset = chunkStart + chunkSize;
  }

  if (!desc || dataByteOffset === null || dataByteLength === null) {
    throw new TypeError('decodeCaf: missing desc or data chunk');
  }
  if (desc.formatID !== 'lpcm') {
    throw new Error(`decodeCaf: unsupported format "${desc.formatID}" (only linear PCM is supported)`);
  }
  const isFloat = (desc.formatFlags & CAF_FLAG_IS_FLOAT) !== 0;
  if (!isFloat && desc.bitsPerChannel !== 16) {
    throw new Error('decodeCaf: unsupported PCM layout (only 32-bit float and 16-bit signed integer are supported)');
  }

  return decodePcm(
    view,
    {
      sampleRate: desc.sampleRate,
      channels: desc.channels,
      bitsPerChannel: desc.bitsPerChannel,
      isFloat,
      littleEndian: (desc.formatFlags & CAF_FLAG_IS_LITTLE_ENDIAN) !== 0,
      dataByteOffset,
      dataByteLength,
    },
    region,
  );
}

/** Dispatches to `decodeWav`/`decodeCaf` by file extension. */
export function decodeAudioFile(
  bytes: Uint8Array,
  filename: string,
  region?: DecodeAudioRegion,
): AudioBufferLike {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return decodeWav(bytes, region);
  if (lower.endsWith('.caf')) return decodeCaf(bytes, region);
  throw new Error(`decodeAudioFile: unsupported file extension in "${filename}" (only .wav and .caf are supported)`);
}

export const AudioLoader = {
  decode: decodeAudioFile,
  decodeWav,
  decodeCaf,
};
