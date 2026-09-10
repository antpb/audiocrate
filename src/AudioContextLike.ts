/**
 * The subset of the real (browser) AudioContext that AudioScene depends on.
 * Kept as a narrow interface, not `globalThis.AudioContext` directly, so
 * `AudioScene` is constructible in a non-browser test or an OfflineRenderer
 * (section 15) by injecting a fake, without either of those depending on a
 * real audio device or a DOM global existing at all.
 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: 'suspended' | 'running' | 'closed';
  resume(): Promise<void>;
  close(): Promise<void>;
}
