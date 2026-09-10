import type { IrAssetData } from '../graph/assets';
import { decodeAudioFile } from './AudioLoader';

/**
 * Impulse responses are audio files (WAV/CAF today, same as `AudioLoader`).
 * This exists so a caller who means "load a space" does not have to know
 * that, and so the archive convention `assets/IR/` has one owner.
 *
 * Mono IRs use `samples`. A stereo file keeps `samplesR` for a host that
 * wants independent L/R cabinets; a mono convolver reads `samples` only.
 */
export function decodeImpulseResponse(bytes: Uint8Array, filename: string): IrAssetData {
  const buffer = decodeAudioFile(bytes, filename);
  return {
    filename,
    samples: buffer.getChannelData(0),
    samplesR: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : undefined,
    sampleRate: buffer.sampleRate,
  };
}

export const IRLoader = {
  decode: decodeImpulseResponse,
};
