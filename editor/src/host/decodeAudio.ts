import { decodeAudioFile, type AudioBufferLike } from '../../../src/index';

export async function decodeHostedAudio(
  bytes: Uint8Array,
  uri: string,
  ctx?: AudioContext | null,
): Promise<AudioBufferLike | null> {
  try {
    return decodeAudioFile(bytes, uri);
  } catch (err) {
    console.warn(`[editor] crate decode failed ${uri}: ${(err as Error).message}`);
  }

  const audioCtx = ctx && ctx.state !== 'closed' ? ctx : null;
  if (!audioCtx || typeof audioCtx.decodeAudioData !== 'function') return null;

  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const decoded = await audioCtx.decodeAudioData(copy);
    return {
      sampleRate: decoded.sampleRate,
      length: decoded.length,
      numberOfChannels: decoded.numberOfChannels,
      getChannelData: (channel: number) => decoded.getChannelData(channel),
    };
  } catch (err) {
    console.warn(`[editor] browser decode failed ${uri}: ${(err as Error).message}`);
    return null;
  }
}
