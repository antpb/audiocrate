/** Synth as a `source` kernel. Ignores input and generates from MIDI notes. */
import { createSynthFx } from './engine/SynthEngine';
import type { SynthProcessor } from './engine/SynthProcessor';
import type { KernelFactory, KernelProcessor } from './crate';

export interface SynthKernelPayload {
  /** `synth_fx.wasm` bytes. */
  wasm?: ArrayBuffer;
}

export type SynthKernelMessage =
  | { type: 'setIRSlot'; slot: number; samples: Float32Array }
  | { type: 'clearIRSlot'; slot: number };

/** MIDI CC map, same as the native plugin. */
function applySynthCc(params: Record<string, number>, cc: number, value: number): boolean {
  const unit = Math.max(0, Math.min(1, value / 127));
  if (cc === 1) {
    params.lfo1Depth = unit;
    return true;
  }
  if (cc === 7) {
    params.masterGain = unit * 2;
    return true;
  }
  if (cc === 10) {
    params.masterPan = unit * 2 - 1;
    return true;
  }
  if (cc === 71) {
    params.filterResonance = unit;
    return true;
  }
  if (cc === 74) {
    params.filterCutoff = 20 * 1000 ** unit;
    return true;
  }
  return false;
}

class SynthKernel implements KernelProcessor {
  constructor(private readonly engine: SynthProcessor) {}

  applyParams(params: Record<string, number>): void {
    this.engine.applyParams(params);
  }

  processSource(
    _inputL: Float32Array,
    _inputR: Float32Array | null,
    outputL: Float32Array,
    outputR: Float32Array | null,
  ): void {
    this.engine.process(outputL, outputR);
  }

  noteOn(note: number, velocity: number): void {
    this.engine.noteOn(note, velocity);
  }

  noteOff(note: number): void {
    this.engine.noteOff(note);
  }

  allNotesOff(): void {
    this.engine.allNotesOff();
  }

  controlChange(cc: number, value: number, params: Record<string, number>): void {
    if (applySynthCc(params, cc, value)) this.engine.applyParams(params);
  }

  setHostBpm(bpm: number): void {
    this.engine.setHostBpm(bpm);
  }

  onMessage(message: unknown): unknown {
    const msg = message as SynthKernelMessage;
    if (msg?.type === 'setIRSlot') this.engine.setIRSlot(msg.slot, msg.samples);
    else if (msg?.type === 'clearIRSlot') this.engine.clearIRSlot(msg.slot);
    return undefined;
  }

  dispose(): void {
    this.engine.dispose();
  }
}

export const synthKernelFactory: KernelFactory = async (sampleRate, payload) => {
  const { wasm } = (payload ?? {}) as SynthKernelPayload;
  if (!wasm) throw new Error('synth kernel needs synth_fx.wasm bytes in its payload');
  // A copy, not the original buffer: the worklet realm keeps a reference for
  // the life of the module and a shared one can be neutered by a later
  // transfer.
  return new SynthKernel(await createSynthFx(sampleRate, { wasmBinary: wasm.slice(0) }));
};
