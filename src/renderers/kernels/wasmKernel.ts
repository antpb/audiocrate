/**
 * The portable kernel: DSP a worklet can run without having been built with
 * it.
 *
 * An AudioWorklet has no dynamic `import()`, so **the kernels a worklet can
 * run are fixed when it is bundled**. That is the platform, not a crate
 * choice. Installing a Material package gets you the main-thread half (param
 * schema, preset decoder, registration). The audio-thread half has to have
 * been compiled into a bundle before the page loaded.
 *
 * A worklet cannot import *code*. It can instantiate a WASM module from
 * *bytes* it is handed. A portable kernel is a freestanding WASM module plus
 * a plain-data descriptor. The glue lives in crate's shipped worklet. The
 * cost is that a portable kernel cannot be arbitrary JS, which also means
 * installing a Material does not run its author's code on the audio thread.
 *
 * Anything expressible as ASL nodes needs no kernel at all, because a graph
 * is data and data crosses the boundary. The richer ASL is, the fewer
 * Materials need a kernel.
 *
 * ## Loading one
 *
 * A Material's graph names its own slot, `kernel.seam('acme.tapedelay')`, and
 * its plugin calls `voice.loadKernel('acme.tapedelay', { binary, descriptor
 * })`. The worklet has no factory registered under that name, sees a WASM
 * payload, and uses this one. Nothing was rebuilt.
 *
 * ## The ABI, version 1
 *
 * A module must export a `memory` and:
 *
 * | Export | Signature | |
 * |---|---|---|
 * | `crate_abi_version` | `() -> i32` | must return 1 |
 * | `crate_init` | `(sampleRate: i32, maxFrames: i32) -> i32` | returns a nonzero handle |
 * | `crate_input_ptr` | `(handle: i32, channel: i32) -> i32` | byte offset of a f32 block, 0 for "no such channel" |
 * | `crate_output_ptr` | `(handle: i32, channel: i32) -> i32` | same |
 * | `crate_process` | `(handle: i32, frames: i32) -> void` | |
 *
 * and may export `crate_set_param(handle, id: i32, value: f32)`,
 * `crate_note_on(handle, note: i32, velocity: f32)`,
 * `crate_note_off(handle, note: i32)`, `crate_all_notes_off(handle)`,
 * `crate_control_change(handle, cc: i32, value: i32)`,
 * `crate_set_bpm(handle, bpm: f32)`, `crate_latency(handle) -> i32`, and
 * `crate_dispose(handle)`.
 *
 * Pointers are byte offsets into the exported memory and must be nonzero,
 * because 0 is how a module says a channel does not exist. They are read
 * fresh every block, so a module may move its buffers, and the views here are
 * rebuilt whenever the module grows its memory (growth detaches every
 * existing view, which would otherwise be a silent read of nothing).
 *
 * ## What crate hands the module
 *
 * One import, `env.abort`, which throws. Nothing else: no console, no clock,
 * no random source, no memory. A kernel that wants noise brings its own PRNG.
 * The import surface is the capability surface.
 *
 * `testing/wasmKernelFixture.ts` is a complete conforming module in about a
 * page of bytes, and is the reference for what "freestanding" means here.
 */
import type { KernelFactory, KernelProcessor } from '../kernel';

/**
 * The slot crate's own worklets register this under. A third-party Material
 * does not need it: any slot with no registered factory falls through to
 * this kernel when the payload carries a descriptor. It exists so a Material
 * can also name the generic slot outright.
 */
export const WASM_KERNEL_SLOT = 'wasm';

export const CRATE_KERNEL_ABI_VERSION = 1;

/** Default block size a kernel is initialised for. Longer blocks are chunked. */
const DEFAULT_MAX_FRAMES = 128;

/**
 * Plain data describing a portable kernel. Ships beside the binary, in a
 * package or a preset, and is JSON: it has to survive `postMessage` into the
 * worklet realm.
 */
export interface WasmKernelDescriptor {
  abi: 1;
  /** For `describe()` and error messages. Not interpreted. */
  name?: string;
  /** Which shape this kernel is, matching `kernel.seam` / `kernel.source`. */
  mode: 'seam' | 'source';
  /** Channels the module handles itself. Only meaningful for `source`. */
  channels?: 1 | 2;
  /**
   * Material param name to the integer id `crate_set_param` expects. Ids
   * rather than names because a name would have to be written into the
   * module's memory, and an integer is something every toolchain can take.
   * Params not listed here are simply not forwarded.
   */
  params?: Readonly<Record<string, number>>;
  /**
   * Latency in samples, for a module that does not export `crate_latency`.
   * Declared rather than measured: PDC has to know before the first block.
   */
  latencySamples?: number;
  /** Frames per `crate_process` call. Defaults to 128. */
  maxFrames?: number;
}

export interface WasmKernelPayload {
  binary: ArrayBuffer | Uint8Array;
  descriptor: WasmKernelDescriptor;
  /** Applied before the first block, so a kernel never runs one block wrong. */
  params?: Record<string, number>;
}

interface KernelExports {
  memory: WebAssembly.Memory;
  crate_abi_version(): number;
  crate_init(sampleRate: number, maxFrames: number): number;
  crate_input_ptr(handle: number, channel: number): number;
  crate_output_ptr(handle: number, channel: number): number;
  crate_process(handle: number, frames: number): void;
  crate_set_param?(handle: number, id: number, value: number): void;
  crate_note_on?(handle: number, note: number, velocity: number): void;
  crate_note_off?(handle: number, note: number): void;
  crate_all_notes_off?(handle: number): void;
  crate_control_change?(handle: number, cc: number, value: number): void;
  crate_set_bpm?(handle: number, bpm: number): void;
  crate_latency?(handle: number): number;
  crate_dispose?(handle: number): void;
}

/** Everything a portable kernel is allowed to reach. Deliberately one function. */
function kernelImports(): WebAssembly.Imports {
  return {
    env: {
      abort(): void {
        throw new Error('crate wasm kernel aborted');
      },
    },
  };
}

function requireFunction(exports: Record<string, unknown>, name: string): void {
  if (typeof exports[name] !== 'function') {
    throw new Error(`crate wasm kernel: missing required export "${name}"`);
  }
}

class WasmKernel implements KernelProcessor {
  /** Views onto the module's memory, rebuilt when the module grows it. */
  private buffer: ArrayBuffer | null = null;
  private views = new Map<number, Float32Array>();

  constructor(
    private readonly exports: KernelExports,
    private readonly handle: number,
    private readonly descriptor: WasmKernelDescriptor,
    private readonly maxFrames: number,
  ) {}

  /**
   * A f32 view of `frames` samples at a byte offset, cached per offset. WASM
   * memory growth detaches every existing view, so the cache is dropped
   * whenever the underlying buffer identity changes; without that check a
   * kernel that allocated mid-run would go silent rather than fail.
   */
  private view(ptr: number, frames: number): Float32Array | null {
    if (ptr === 0) return null;
    const memory = this.exports.memory.buffer;
    if (memory !== this.buffer) {
      this.buffer = memory;
      this.views.clear();
    }
    let view = this.views.get(ptr);
    if (!view || view.length < frames) {
      view = new Float32Array(memory, ptr, this.maxFrames);
      this.views.set(ptr, view);
    }
    return view.subarray(0, frames);
  }

  applyParams(params: Record<string, number>): void {
    const map = this.descriptor.params;
    const set = this.exports.crate_set_param;
    if (!map || !set) return;
    for (const name in map) {
      const value = params[name];
      if (value !== undefined) set(this.handle, map[name]!, value);
    }
  }

  /**
   * Runs the module in `maxFrames` chunks. A caller is free to hand crate a
   * longer block than the kernel was initialised for (`OfflineRenderer` with
   * a large buffer, a test), and truncating there would drop audio silently.
   */
  private run(
    frames: number,
    write: (offset: number, count: number) => void,
  ): void {
    for (let offset = 0; offset < frames; offset += this.maxFrames) {
      write(offset, Math.min(this.maxFrames, frames - offset));
    }
  }

  processSeam(input: Float32Array, output: Float32Array): void {
    this.run(output.length, (offset, count) => {
      const into = this.view(this.exports.crate_input_ptr(this.handle, 0), count);
      if (!into) return;
      into.set(input.subarray(offset, offset + count));
      this.exports.crate_process(this.handle, count);
      const from = this.view(this.exports.crate_output_ptr(this.handle, 0), count);
      if (from) output.set(from, offset);
    });
  }

  processSource(
    inputL: Float32Array,
    inputR: Float32Array | null,
    outputL: Float32Array,
    outputR: Float32Array | null,
  ): void {
    this.run(outputL.length, (offset, count) => {
      const inL = this.view(this.exports.crate_input_ptr(this.handle, 0), count);
      if (inL) inL.set(inputL.subarray(offset, offset + count));
      const inRight = this.view(this.exports.crate_input_ptr(this.handle, 1), count);
      // A mono source feeding a stereo kernel gets the same signal on both
      // sides rather than silence on the right, matching how an unbound
      // `audio.right()` reads.
      if (inRight) inRight.set((inputR ?? inputL).subarray(offset, offset + count));

      this.exports.crate_process(this.handle, count);

      const outL = this.view(this.exports.crate_output_ptr(this.handle, 0), count);
      if (outL) outputL.set(outL, offset);
      if (outputR) {
        const right = this.view(this.exports.crate_output_ptr(this.handle, 1), count);
        // A mono kernel on a stereo destination mirrors, so a module that
        // only fills channel 0 is still correct rather than half-silent.
        outputR.set(right ?? outL ?? new Float32Array(count), offset);
      }
    });
  }

  noteOn(note: number, velocity: number): void {
    this.exports.crate_note_on?.(this.handle, note, velocity);
  }

  noteOff(note: number): void {
    this.exports.crate_note_off?.(this.handle, note);
  }

  allNotesOff(): void {
    this.exports.crate_all_notes_off?.(this.handle);
  }

  controlChange(cc: number, value: number): void {
    this.exports.crate_control_change?.(this.handle, cc, value);
  }

  setHostBpm(bpm: number): void {
    this.exports.crate_set_bpm?.(this.handle, bpm);
  }

  latencySamples(): number {
    if (this.exports.crate_latency) return this.exports.crate_latency(this.handle) | 0;
    return this.descriptor.latencySamples ?? 0;
  }

  describe(): unknown {
    return {
      portable: true,
      abi: CRATE_KERNEL_ABI_VERSION,
      name: this.descriptor.name ?? null,
      mode: this.descriptor.mode,
      maxFrames: this.maxFrames,
      latencySamples: this.latencySamples(),
    };
  }

  dispose(): void {
    this.exports.crate_dispose?.(this.handle);
    this.views.clear();
    this.buffer = null;
  }
}

/** Whether a `loadKernel` payload is a portable kernel rather than a plugin's own. */
export function isWasmKernelPayload(payload: unknown): payload is WasmKernelPayload {
  const candidate = payload as WasmKernelPayload | null;
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    !!candidate.binary &&
    !!candidate.descriptor &&
    typeof candidate.descriptor === 'object'
  );
}

/**
 * Instantiates a portable kernel. Every failure here is thrown rather than
 * degraded, unlike a plugin's own factory: a malformed profile is a
 * configuration a user can legitimately be in, but a module that does not
 * meet the ABI is a packaging bug its author needs told about, and
 * `loadKernel`'s rejection is how they find out.
 */
export const wasmKernelFactory: KernelFactory = async (sampleRate, payload) => {
  if (!isWasmKernelPayload(payload)) {
    throw new Error('crate wasm kernel: payload needs { binary, descriptor }');
  }
  const { binary, descriptor } = payload;
  if (descriptor.abi !== CRATE_KERNEL_ABI_VERSION) {
    throw new Error(
      `crate wasm kernel: descriptor declares ABI ${String(descriptor.abi)}, this build speaks ${CRATE_KERNEL_ABI_VERSION}`,
    );
  }

  const bytes = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
  const module = await WebAssembly.compile(bytes as unknown as BufferSource);
  const instance = await WebAssembly.instantiate(module, kernelImports());
  const exports = instance.exports as unknown as Record<string, unknown>;

  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('crate wasm kernel: module must export its memory');
  }
  for (const name of ['crate_abi_version', 'crate_init', 'crate_input_ptr', 'crate_output_ptr', 'crate_process']) {
    requireFunction(exports, name);
  }

  const typed = exports as unknown as KernelExports;
  const moduleAbi = typed.crate_abi_version();
  if (moduleAbi !== CRATE_KERNEL_ABI_VERSION) {
    throw new Error(
      `crate wasm kernel: module reports ABI ${moduleAbi}, this build speaks ${CRATE_KERNEL_ABI_VERSION}`,
    );
  }

  const maxFrames = Math.max(1, Math.floor(descriptor.maxFrames ?? DEFAULT_MAX_FRAMES));
  const handle = typed.crate_init(sampleRate, maxFrames);
  if (!handle) {
    throw new Error('crate wasm kernel: crate_init returned 0, meaning it refused to start');
  }

  const kernel = new WasmKernel(typed, handle, descriptor, maxFrames);
  if (payload.params) kernel.applyParams(payload.params);
  return kernel;
};
