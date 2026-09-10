/**
 * TS's DOM lib doesn't declare the AudioWorklet global scope (it's a
 * separate spec from the main-thread AudioContext types it does declare).
 * Minimal ambient declarations for the one file (crate-voice-processor.ts)
 * that actually runs in that scope.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare module '*?worklet' {
  const url: string;
  export default url;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;
/** The worklet scope's own clock, in the same units as `AudioContext.currentTime`. */
declare const currentTime: number;
