/**
 * Amp audio-thread kernel. Signal path at the AudioMaterial seam:
 *
 * ```
 *   ...ASL tone stack...  ->  [ pre: delay A/B, pre-amp reverb ]
 *                             [ neural inference (NAM)        ]
 *                             [ post: IR, delay C, reverb, D  ]  -> ...ASL output gain...
 * ```
 *
 * Placement matches the native kernel. This file is the only one that
 * imports both emscripten engines.
 */
import { createNamModel } from './nam/NamEngine';
import { createAmpFx } from './fx/AmpFxEngine';
import type { NamProcessor } from './nam/NamProcessor';
import type { AmpFxProcessor } from './fx/AmpFxProcessor';
import type { KernelFactory, KernelProcessor } from './crate';

/** What `VoiceHandle.loadKernel(AMP_KERNEL_SLOT, ...)` must be given. */
export interface AmpKernelPayload {
  /** `amp_fx.wasm` bytes. Without it the reverb/delay/IR stages are skipped and NAM still runs. */
  ampFxWasm?: ArrayBuffer | Uint8Array;
  /** `nam.wasm` bytes. Required to run a profile at all. */
  namWasm?: ArrayBuffer | Uint8Array;
  /** `.nam` profile JSON. Absent means the analog path. */
  namJson?: string;
  /**
   * Companion profile for the right channel when `stereoMode` is on and
   * `channelLink` is off, or morph target B. Absent means the right side
   * clones the primary profile.
   */
  namJsonR?: string;
}

/** Messages this kernel accepts through `VoiceHandle.sendKernel`. */
export type AmpKernelMessage =
  | { type: 'setIR'; samples: Float32Array }
  | { type: 'clearIR' }
  | { type: 'loadNam'; json: string }
  | { type: 'latency' };

let namMaxFrames = 256;

/** NAM's process allocation. Auto (0 or unset) is 256, matching the shipped default. */
export function setNamMaxFrames(frames: number): void {
  namMaxFrames = frames > 0 ? Math.floor(frames) : 256;
}

export function getNamMaxFrames(): number {
  return namMaxFrames;
}

class AmpKernel implements KernelProcessor {
  private scratch: Float32Array | null = null;

  constructor(
    private readonly sampleRate: number,
    private nam: NamProcessor | null,
    private readonly fx: AmpFxProcessor | null,
    private readonly namWasm: ArrayBuffer | Uint8Array | undefined,
    private namR: NamProcessor | null = null,
  ) {}

  applyParams(params: Record<string, number>): void {
    this.fx?.applyParams(params);
  }

  processSeam(input: Float32Array, output: Float32Array): void {
    this.processNamed(this.nam, input, output);
  }

  processSource(
    inputL: Float32Array,
    inputR: Float32Array | null,
    outputL: Float32Array,
    outputR: Float32Array | null,
  ): void {
    const frames = outputL.length;
    const stereo = Boolean(inputR && outputR);
    if (!stereo || !inputR || !outputR) {
      if (inputR) {
        const mix = this.mixScratch(frames);
        for (let i = 0; i < frames; i++) mix[i] = 0.5 * ((inputL[i] ?? 0) + (inputR[i] ?? 0));
        this.processNamed(this.nam, mix, outputL);
      } else {
        this.processNamed(this.nam, inputL, outputL);
      }
      if (outputR) outputR.set(outputL.subarray(0, frames));
      return;
    }
    this.processNamed(this.nam, inputL, outputL);
    this.processNamed(this.namR ?? this.nam, inputR, outputR);
  }

  private processNamed(nam: NamProcessor | null, input: Float32Array, output: Float32Array): void {
    this.fx?.processPre(input);
    if (nam) nam.processBlock(input, output);
    else if (input !== output) output.set(input);
    this.fx?.processPost(output);
  }

  private mixScratch(frames: number): Float32Array {
    if (!this.scratch || this.scratch.length < frames) this.scratch = new Float32Array(frames);
    return this.scratch;
  }

  processSeamSample(x: number): number {
    // Single-sample path, for the interpreter's per-sample mode. The FX
    // engines are block-only, so this is inference alone; nothing calls it on
    // a real-time path.
    return this.nam ? this.nam.processSample(x) : x;
  }

  controlChange(cc: number, value: number, params: Record<string, number>): void {
    // The amp's one CC binding: a user-assignable switch for delay
    // oscillation. Held here rather than in the worklet, because which CC it
    // listens on is a *param* of this plugin, not host policy.
    const oscCc = Math.round(params.delayOscCC ?? 27);
    if (cc !== oscCc) return;
    params.delayOscillate = value >= 64 ? 1 : 0;
    this.fx?.applyParams(params);
  }

  setHostBpm(bpm: number): void {
    this.fx?.setHostBpm(bpm);
  }

  latencySamples(): number {
    return this.fx?.latencySamples() ?? 0;
  }

  /** Architecture and whether the A2-fast kernel instantiated. */
  describe(): unknown {
    return {
      hasFx: !!this.fx,
      architecture: this.nam?.architecture ?? null,
      a2Fast: this.nam?.a2Fast ?? false,
      a2Channels: this.nam?.a2Channels ?? 0,
      hasNamR: !!this.namR,
    };
  }

  onMessage(message: unknown): unknown {
    const msg = message as AmpKernelMessage;
    if (msg?.type === 'setIR') {
      this.fx?.setIR(msg.samples);
      return { latencySamples: this.latencySamples() };
    }
    if (msg?.type === 'clearIR') {
      this.fx?.clearIR();
      return { latencySamples: this.latencySamples() };
    }
    if (msg?.type === 'loadNam') {
      // Old model keeps running until the new one is ready.
      void this.swapNam(msg.json);
      return undefined;
    }
    if (msg?.type === 'latency') return { latencySamples: this.latencySamples() };
    return undefined;
  }

  private async swapNam(json: string): Promise<void> {
    if (!this.namWasm) return;
    const next = await tryCreateNam(json, this.sampleRate, this.namWasm);
    if (!next) return;
    const previous = this.nam;
    this.nam = next;
    previous?.dispose();
  }

  dispose(): void {
    this.nam?.dispose();
    this.nam = null;
    this.namR?.dispose();
    this.namR = null;
    this.fx?.dispose();
    this.scratch = null;
  }
}

/**
 * Worklet or offline. Missing `amp_fx.wasm` still runs NAM. Missing profile
 * is the analog path.
 */
export const ampKernelFactory: KernelFactory = async (sampleRate, payload) => {
  const { ampFxWasm, namWasm, namJson, namJsonR } = (payload ?? {}) as AmpKernelPayload;
  const fx = ampFxWasm ? await createAmpFx(sampleRate, { wasmBinary: ampFxWasm }) : null;
  const nam = namJson && namWasm ? await tryCreateNam(namJson, sampleRate, namWasm) : null;
  const namR = namJsonR && namWasm ? await tryCreateNam(namJsonR, sampleRate, namWasm) : null;
  return new AmpKernel(sampleRate, nam, fx, namWasm, namR);
};

/**
 * Malformed NAM `abort()`s in WASM and throws `RuntimeError` here. Catch it
 * so loadKernel still installs reverb and delay; fall back to analog.
 */
async function tryCreateNam(
  json: string,
  sampleRate: number,
  wasmBinary: ArrayBuffer | Uint8Array,
): Promise<NamProcessor | null> {
  try {
    return await createNamModel(json, sampleRate, namMaxFrames, { wasmBinary });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[amp] profile failed to load; running the analog path', err);
    return null;
  }
}
