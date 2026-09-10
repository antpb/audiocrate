/// <reference types="vite/client" />

declare module '*?worklet' {
  const url: string;
  export default url;
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  process(...args: unknown[]): boolean;
}

declare function registerProcessor(name: string, processorCtor: unknown): void;

declare const sampleRate: number;
declare const currentTime: number;
