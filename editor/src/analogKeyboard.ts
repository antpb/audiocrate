/**
 * Host keyboard for the editor, not a crate AudioMaterial.
 *
 * Analog jacks (cv, gate, trig, velocity) are last-note, like a hardware
 * mono keyboard. CV is 1V/oct with A4 at 0V. note/gate cables into an AudioMaterial
 * are polyphonic; voice lamps follow that target.
 */

import { A4_MIDI as CRATE_A4_MIDI, MIDI_TRIG_SECONDS } from '../../src/index';

/**
 * Re-exported rather than restated. A keyboard trig and a MIDI In trig are the
 * same edge and were the same number written twice, in this file and in
 * `audio.ts`, with nothing holding them together. Crate owns both now
 * (`midi/midiHostIo.ts`), so a host that changes the pulse width changes it
 * for every jack that emits one.
 */
export const A4_MIDI = CRATE_A4_MIDI;
export const TRIG_SECONDS = MIDI_TRIG_SECONDS;

export interface HeldKey {
  note: number;
  velocity: number;
}

export interface VoiceLamp {
  index: number;
  note: number | null;
  held: boolean;
}

export interface AnalogSnapshot {
  note: number;
  velocity: number;
  gate: number;
  cv: number;
  held: number[];
  polyphony: number;
  steal: string;
  targetName: string;
  lamps: VoiceLamp[];
}

export function stealLabel(steal: unknown): string {
  return steal === 'quietest' ? 'quietest' : 'oldest';
}

export function lampsFromHeld(held: number[], polyphony: number): VoiceLamp[] {
  const count = Math.max(1, polyphony);
  const lamps: VoiceLamp[] = Array.from({ length: count }, (_, index) => ({
    index,
    note: null,
    held: false,
  }));
  const window = held.slice(-count);
  for (let i = 0; i < window.length; i += 1) {
    lamps[i] = { index: i, note: window[i]!, held: true };
  }
  return lamps;
}

export type AnalogListener = (event: AnalogEvent) => void;

export interface AnalogEvent {
  type: 'press' | 'release';
  note: number;
  velocity: number;
  snapshot: AnalogSnapshot;
}

export function voltsFromMidi(note: number): number {
  return (note - A4_MIDI) / 12;
}

export class AnalogKeyboard {
  octave = 4;
  velocity = 0.85;
  polyphony = 1;
  steal = 'oldest';
  targetName = '';
  private liveLamps: VoiceLamp[] | null = null;
  private readonly stack: HeldKey[] = [];
  private readonly listeners = new Set<AnalogListener>();
  private lastNote = A4_MIDI;
  private lastVelocity = 0.85;

  on(listener: AnalogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get snapshot(): AnalogSnapshot {
    const top = this.stack[this.stack.length - 1];
    const note = top?.note ?? this.lastNote;
    const velocity = top?.velocity ?? this.lastVelocity;
    const held = this.stack.map((key) => key.note);
    return {
      note,
      velocity,
      gate: this.stack.length > 0 ? 1 : 0,
      cv: voltsFromMidi(note),
      held,
      polyphony: this.polyphony,
      steal: this.steal,
      targetName: this.targetName,
      lamps: this.liveLamps ?? lampsFromHeld(held, this.polyphony),
    };
  }

  setVoiceView(view: { polyphony: number; steal: string; targetName: string; lamps?: VoiceLamp[] }): void {
    const next = Math.max(1, view.polyphony);
    if (next !== this.polyphony) this.liveLamps = null;
    this.polyphony = next;
    this.steal = view.steal;
    this.targetName = view.targetName;
    if (view.lamps !== undefined) this.liveLamps = view.lamps;
  }

  press(note: number, velocity = this.velocity): AnalogSnapshot {
    const vel = clamp01(velocity);
    const existing = this.stack.findIndex((key) => key.note === note);
    if (existing >= 0) this.stack.splice(existing, 1);
    this.stack.push({ note, velocity: vel });
    this.lastNote = note;
    this.lastVelocity = vel;
    const snapshot = this.snapshot;
    this.emit({ type: 'press', note, velocity: vel, snapshot });
    return snapshot;
  }

  release(note: number): AnalogSnapshot {
    const index = this.stack.findIndex((key) => key.note === note);
    if (index < 0) return this.snapshot;
    this.stack.splice(index, 1);
    const top = this.stack[this.stack.length - 1];
    this.lastNote = top?.note ?? note;
    if (top) this.lastVelocity = top.velocity;
    const snapshot = this.snapshot;
    this.emit({ type: 'release', note, velocity: snapshot.velocity, snapshot });
    return snapshot;
  }

  releaseAll(): AnalogSnapshot {
    const notes = [...this.snapshot.held];
    for (const note of notes) this.release(note);
    return this.snapshot;
  }

  midiForDegree(degree: number): number {
    return (this.octave + 1) * 12 + degree;
  }

  private emit(event: AnalogEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** After an awaited Play (mic prompt, kernel load), drop notes that lifted and re-strike ones still down. */
export function reconcileHeld(held: readonly number[], physical: ReadonlySet<number>): { drop: number[]; strike: number[] } {
  return {
    drop: held.filter((note) => !physical.has(note)),
    strike: [...physical],
  };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Ableton-style two-row computer keyboard, degrees from the current C. */
export const COMPUTER_DEGREES: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ';': 16,
};

export const KEYBOARD_KIND = 'keyboard';
export const KEYBOARD_OUTPUTS = ['cv', 'gate', 'trig', 'velocity'] as const;
export type KeyboardOutput = (typeof KEYBOARD_OUTPUTS)[number];

export function isKeyboardKind(kind: string): boolean {
  return kind === KEYBOARD_KIND;
}

export function isControlJack(name: string): boolean {
  return name === 'note' || name === 'gate' || name === 'velocity' || name === 'trig' || name === 'cv';
}
