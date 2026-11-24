/**
 * The drum on the audio thread: homecrate-drum-vst3's DrumEngine (vst3/),
 * which ports the AUv3's Swift voice and its C++ kernel, compiled to WASM.
 *
 * The ASL graph in drumMaterial.ts is the 026S chain as a graph, and runs
 * everywhere; but sixteen chains on every sample is more than an audio thread
 * has, and it has no SOLA stretch, choke or humanize. This is the AU's own
 * playback: idle pads cost nothing, and a kit sounds as saved.
 */
import createDrumFxModule, { type DrumFxModule } from '../wasm/dist/drum_fx.js';
import type { KernelFactory, KernelProcessor, TransportSnapshot } from './crate';
import { drumParams } from './drumParams';

export { DRUM_KERNEL_SLOT } from './kernelSlot';

export interface DrumKernelPayload {
  /** `drum_fx.wasm` bytes. */
  wasm: ArrayBuffer;
}

/** One decoded pad sample, at its own rate (the engine resamples). */
export type DrumKernelMessage = { type: 'loadPad'; pad: number; left: Float32Array; right: Float32Array | null; sampleRate: number };

const MAX_FRAMES = 128;
const ADDRESSES = Object.entries(drumParams)
  .filter(([, d]) => d.address !== undefined)
  .map(([name, d]) => [name, d.address!] as const);

let modulePromise: Promise<DrumFxModule> | null = null;

class DrumKernel implements KernelProcessor {
  private readonly last = new Map<string, number>();

  constructor(private readonly mod: DrumFxModule, private handle: number) {}

  applyParams(params: Record<string, number>): void {
    if (!this.handle) return;
    for (const [name, address] of ADDRESSES) {
      const value = params[name];
      if (value === undefined || this.last.get(name) === value) continue;
      this.last.set(name, value);
      this.mod._drumfx_set_param(this.handle, address, value);
    }
  }

  setTransport(t: TransportSnapshot): void {
    if (this.handle) this.mod._drumfx_set_context(this.handle, t.playing ? 1 : 0, t.beats, t.bpm);
  }

  processSource(_inputL: Float32Array, _inputR: Float32Array | null, outputL: Float32Array, outputR: Float32Array | null): void {
    if (!this.handle) {
      outputL.fill(0);
      outputR?.fill(0);
      return;
    }
    const mod = this.mod;
    for (let offset = 0; offset < outputL.length; offset += MAX_FRAMES) {
      const frames = Math.min(MAX_FRAMES, outputL.length - offset);
      mod._drumfx_process(this.handle, frames);
      const heap = mod.HEAPF32;
      const l = mod._drumfx_buffer(this.handle, 0) >> 2;
      const r = mod._drumfx_buffer(this.handle, 1) >> 2;
      outputL.set(heap.subarray(l, l + frames), offset);
      outputR?.set(heap.subarray(r, r + frames), offset);
    }
  }

  noteOn(note: number, velocity: number): void {
    if (this.handle) this.mod._drumfx_note_on(this.handle, note, velocity);
  }

  // A pad is a one-shot: the AU ignores note-offs, and so does the engine.
  noteOff(): void {}

  onMessage(message: unknown): unknown {
    const m = message as DrumKernelMessage;
    if (m?.type !== 'loadPad' || !this.handle) return undefined;
    const mod = this.mod;
    const bytes = m.left.length * 4;
    const left = mod._malloc(bytes);
    mod.HEAPF32.set(m.left, left >> 2);
    let right = 0;
    if (m.right) {
      right = mod._malloc(bytes);
      mod.HEAPF32.set(m.right, right >> 2);
    }
    mod._drumfx_load_pad(this.handle, m.pad, left, right, m.left.length, m.sampleRate);
    mod._free(left);
    if (right) mod._free(right);
    return undefined;
  }

  dispose(): void {
    if (!this.handle) return;
    this.mod._drumfx_destroy(this.handle);
    this.handle = 0;
  }
}

export const drumKernelFactory: KernelFactory = async (sampleRate, payload) => {
  const { wasm } = (payload ?? {}) as DrumKernelPayload;
  if (!wasm) throw new Error('drum kernel needs drum_fx.wasm bytes in its payload');
  modulePromise ??= createDrumFxModule({ wasmBinary: wasm.slice(0), locateFile: (path) => path });
  const mod = await modulePromise;
  return new DrumKernel(mod, mod._drumfx_create(sampleRate, MAX_FRAMES));
};
