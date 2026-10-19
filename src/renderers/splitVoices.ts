import type { VoiceHandle } from './WebAudioRenderer';

/**
 * Wires a split instrument: every voice's send `k` into the bus voice's
 * `send{k}` input. Web Audio sums every connection into one input, so this
 * is the voices' sum, and the bus then runs once on it.
 *
 * `voices` must have been created with `{ sends: true }` from the graph whose
 * `bus` made `bus`.
 */
export function connectSplitVoices(voices: readonly VoiceHandle[], bus: VoiceHandle, sendCount: number): void {
  for (let k = 0; k < sendCount; k++) {
    const input = bus.inputIndexFor(`send${k}`);
    for (const voice of voices) voice.node.connect(bus.node, k, input);
  }
}
