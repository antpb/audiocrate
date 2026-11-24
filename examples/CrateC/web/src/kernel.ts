/**
 * The crate kernel: a crate patch run by CrateC in WASM (`web/crate_web.c`).
 *
 * The audio-thread half. One kernel is one patch: an instrument is CrateC's
 * voice pool (polyphony, retirement and the split bus inside the module, so
 * the scene sends it MIDI like the synth), an effect is one state reading
 * the voice's input. The plan is built from the compiled graph's JSON when
 * the kernel loads.
 */
import createCrateWebModule, { type CrateWebModule } from '../dist/crate_web.js';
import type { KernelFactory, KernelProcessor, TransportSnapshot } from '../../../../src/index';

export { CRATE_KERNEL_SLOT } from './kernelSlot';

export interface CrateKernelPayload {
  /** `crate_web.wasm` bytes. */
  wasm: ArrayBuffer;
  /** The compiled document's `graph`, as JSON. */
  graph: string;
  instrument: boolean;
  polyphony?: number;
  seed?: number;
  /** Sample tables the graph refers to as `{ "ext": n }` (`serialize.ts`). */
  tables?: Float32Array[];
}

const MAX_FRAMES = 128;

let modulePromise: Promise<CrateWebModule> | null = null;
function crateModule(wasm: ArrayBuffer): Promise<CrateWebModule> {
  if (!modulePromise) {
    // A copy: the worklet keeps the module for its life, and a buffer the
    // main thread transfers later would be detached under it.
    modulePromise = createCrateWebModule({ wasmBinary: wasm.slice(0), locateFile: (path) => path });
  }
  return modulePromise;
}

class CrateKernel implements KernelProcessor {
  private readonly names: string[] = [];
  private readonly last: Float64Array;
  private bpm = 120;

  constructor(
    private readonly mod: CrateWebModule,
    private handle: number,
    private readonly instrument: boolean,
  ) {
    const count = mod._crateweb_param_count(handle);
    for (let i = 0; i < count; i++) this.names.push(mod.UTF8ToString(mod._crateweb_param_name(handle, i)));
    this.last = new Float64Array(count).fill(Number.NaN);
  }

  applyParams(params: Record<string, number>): void {
    if (!this.handle) return;
    for (let i = 0; i < this.names.length; i++) {
      const value = params[this.names[i]!];
      if (value === undefined || value === this.last[i]) continue;
      this.last[i] = value;
      this.mod._crateweb_set_param(this.handle, i, value);
    }
  }

  setTransport(t: TransportSnapshot): void {
    if (!this.handle) return;
    this.bpm = t.bpm;
    this.mod._crateweb_set_transport(this.handle, t.beats, t.bpm, t.playing ? 1 : 0, t.beatsPerBar, t.beatUnit ?? 4);
  }

  setHostBpm(bpm: number): void {
    this.bpm = bpm;
  }

  processSource(inputL: Float32Array, inputR: Float32Array | null, outputL: Float32Array, outputR: Float32Array | null): void {
    if (!this.handle) {
      outputL.fill(0);
      outputR?.fill(0);
      return;
    }
    const mod = this.mod;
    for (let offset = 0; offset < outputL.length; offset += MAX_FRAMES) {
      const frames = Math.min(MAX_FRAMES, outputL.length - offset);
      // Views are read fresh: a memory growth detaches every earlier one.
      const heap = mod.HEAPF32;
      if (!this.instrument) {
        heap.set(inputL.subarray(offset, offset + frames), mod._crateweb_buffer(this.handle, 0) >> 2);
        if (inputR) heap.set(inputR.subarray(offset, offset + frames), mod._crateweb_buffer(this.handle, 1) >> 2);
      }
      mod._crateweb_process(this.handle, frames, inputR ? 1 : 0);
      const out = mod.HEAPF32;
      const l = mod._crateweb_buffer(this.handle, 2) >> 2;
      const r = mod._crateweb_buffer(this.handle, 3) >> 2;
      outputL.set(out.subarray(l, l + frames), offset);
      outputR?.set(out.subarray(r, r + frames), offset);
    }
  }

  noteOn(note: number, velocity: number): void {
    if (this.handle) this.mod._crateweb_note_on(this.handle, note, velocity);
  }

  noteOff(note: number): void {
    if (this.handle) this.mod._crateweb_note_off(this.handle, note);
  }

  allNotesOff(): void {
    if (this.handle) this.mod._crateweb_all_notes_off(this.handle);
  }

  describe(): unknown {
    return { engine: 'CrateC', params: this.names.length, instrument: this.instrument };
  }

  dispose(): void {
    if (!this.handle) return;
    this.mod._crateweb_destroy(this.handle);
    this.handle = 0;
  }
}

export const crateKernelFactory: KernelFactory = async (sampleRate, payload) => {
  const p = (payload ?? {}) as CrateKernelPayload;
  if (!p.wasm) throw new Error('crate kernel needs crate_web.wasm bytes in its payload');
  if (typeof p.graph !== 'string') throw new Error('crate kernel needs the compiled graph');
  const mod = await crateModule(p.wasm);
  const bytes = mod.lengthBytesUTF8(p.graph);
  const text = mod._malloc(bytes + 1);
  mod.stringToUTF8(p.graph, text, bytes + 1);
  // Tables go in as floats: (pointer, length) pairs, copied by the build.
  const tables = p.tables ?? [];
  const pointers = tables.map((table) => {
    const ptr = mod._malloc(Math.max(4, table.length * 4));
    mod.HEAPF32.set(table, ptr >> 2);
    return ptr;
  });
  const list = tables.length ? mod._malloc(tables.length * 8) : 0;
  tables.forEach((table, i) => {
    mod.HEAPU32[(list >> 2) + i * 2] = pointers[i]!;
    mod.HEAPU32[(list >> 2) + i * 2 + 1] = table.length;
  });
  mod._crateweb_set_tables(list, tables.length);
  const handle = mod._crateweb_create(text, bytes, p.instrument ? 1 : 0, p.polyphony ?? 8, sampleRate, MAX_FRAMES, (p.seed ?? 0) >>> 0);
  mod._free(text);
  for (const ptr of pointers) mod._free(ptr);
  if (list) mod._free(list);
  if (!handle) throw new Error(mod.UTF8ToString(mod._crateweb_last_error()) || 'crate kernel: the patch did not load');
  return new CrateKernel(mod, handle, p.instrument);
};
