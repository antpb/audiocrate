/**
 * The audio-thread half: hc_dynEQ in WASM (dsp/dyneq_kernel.cpp, the AU's
 * kernel ported verbatim), hc_send in plain JS (it copies its input and
 * publishes a peak, nothing a binary would speed up). Both meet on the
 * worklet realm's envelope bus (`envelopeBus.ts`).
 */
import createDyneqModule, { type DyneqModule } from '../wasm/dist/dyneq.js';
import type { KernelFactory, KernelProcessor } from './crate';
import { dyneqParams, sendParams } from './params';
import { claimSendSlot, publishSend, readSendMax, releaseSendSlot } from './envelopeBus';

export { DYNEQ_KERNEL_SLOT, SEND_KERNEL_SLOT } from './kernelSlot';

export interface DyneqKernelPayload {
  /** `dyneq.wasm` bytes. */
  wasm: ArrayBuffer;
}

const MAX_FRAMES = 128;
const DYNEQ_ADDRESSES = Object.entries(dyneqParams).map(([name, d]) => [name, d.address!] as const);

let modulePromise: Promise<DyneqModule> | null = null;

class DyneqKernel implements KernelProcessor {
  private readonly last = new Map<string, number>();

  constructor(private readonly mod: DyneqModule, private handle: number) {}

  applyParams(params: Record<string, number>): void {
    if (!this.handle) return;
    for (const [name, address] of DYNEQ_ADDRESSES) {
      const value = params[name];
      if (value === undefined || this.last.get(name) === value) continue;
      this.last.set(name, value);
      this.mod._dyneq_set_param(this.handle, address, value);
    }
  }

  processSource(inputL: Float32Array, inputR: Float32Array | null, outputL: Float32Array, outputR: Float32Array | null): void {
    if (!this.handle) {
      outputL.set(inputL);
      outputR?.set(inputR ?? inputL);
      return;
    }
    const mod = this.mod;
    for (let offset = 0; offset < outputL.length; offset += MAX_FRAMES) {
      const frames = Math.min(MAX_FRAMES, outputL.length - offset);
      // The AU reads the bus once per block, before it renders.
      const bus = readSendMax();
      let heap = mod.HEAPF32;
      heap.set(inputL.subarray(offset, offset + frames), mod._dyneq_buffer(this.handle, 0) >> 2);
      if (inputR) heap.set(inputR.subarray(offset, offset + frames), mod._dyneq_buffer(this.handle, 1) >> 2);
      mod._dyneq_process(this.handle, frames, inputR ? 1 : 0, bus);
      heap = mod.HEAPF32;
      const l = mod._dyneq_buffer(this.handle, 2) >> 2;
      const r = mod._dyneq_buffer(this.handle, 3) >> 2;
      outputL.set(heap.subarray(l, l + frames), offset);
      outputR?.set(heap.subarray(r, r + frames), offset);
    }
  }

  poll(): unknown {
    if (!this.handle) return undefined;
    return { follower: this.mod._dyneq_follower(this.handle), gainReduction: this.mod._dyneq_gain_reduction(this.handle) };
  }

  dispose(): void {
    if (!this.handle) return;
    this.mod._dyneq_destroy(this.handle);
    this.handle = 0;
  }
}

export const dyneqKernelFactory: KernelFactory = async (sampleRate, payload) => {
  const { wasm } = (payload ?? {}) as DyneqKernelPayload;
  if (!wasm) throw new Error('dynEQ kernel needs dyneq.wasm bytes in its payload');
  modulePromise ??= createDyneqModule({ wasmBinary: wasm.slice(0), locateFile: (path) => path });
  const mod = await modulePromise;
  return new DyneqKernel(mod, mod._dyneq_create(sampleRate, MAX_FRAMES));
};

class SendKernel implements KernelProcessor {
  private level = sendParams.sendLevel!.default;
  private slot = claimSendSlot();

  applyParams(params: Record<string, number>): void {
    const value = params.sendLevel;
    if (value !== undefined) this.level = value;
  }

  processSource(inputL: Float32Array, inputR: Float32Array | null, outputL: Float32Array, outputR: Float32Array | null): void {
    // Bit-exact passthrough, always; the audio is never the send's to change.
    outputL.set(inputL);
    outputR?.set(inputR ?? inputL);
    let peak = 0;
    for (const channel of inputR ? [inputL, inputR] : [inputL]) {
      for (let i = 0; i < channel.length; i++) {
        const m = Math.abs(channel[i]!);
        if (m > peak) peak = m;
      }
    }
    publishSend(this.slot, Math.fround(peak * this.level));
  }

  dispose(): void {
    releaseSendSlot(this.slot);
  }
}

export const sendKernelFactory: KernelFactory = async () => new SendKernel();
