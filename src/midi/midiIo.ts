/**
 * Live MIDI host I/O. Line is the audio capture jack; these are the MIDI
 * ones. Device ids are strings the host stores. They name a port on this
 * machine and must not cross a collab session (`stripHostLocalPatch`).
 * Channel, message, and width are patch settings and do sync. This module
 * is the shared language: which jacks exist, how a pulse plus a note
 * becomes a MIDI gate, and how incoming bytes become the same analog
 * snapshot a Keyboard writes.
 *
 * MIDI In is a source. MIDI Out is a sink. Neither one is DSP. Flatten
 * treats them like Keyboard and Master.
 */

export const MIDI_IN_KIND = 'midiin';
export const MIDI_OUT_KIND = 'midiout';

export const MIDI_IN_OUTPUTS = ['cv', 'gate', 'trig', 'velocity', 'note', 'cc'] as const;
export type MidiInOutput = (typeof MIDI_IN_OUTPUTS)[number];

export const MIDI_OUT_INPUTS = ['note', 'cv', 'gate', 'trig', 'velocity', 'cc'] as const;
export type MidiOutInput = (typeof MIDI_OUT_INPUTS)[number];

export const MIDI_MESSAGE_NAMES = ['Note', 'CC', 'Program'] as const;
export type MidiMessageName = (typeof MIDI_MESSAGE_NAMES)[number];

export const A4_MIDI = 69;

export function isMidiInKind(kind: string): boolean {
  return kind === MIDI_IN_KIND;
}

export function isMidiOutKind(kind: string): boolean {
  return kind === MIDI_OUT_KIND;
}

export function isMidiIoKind(kind: string): boolean {
  return isMidiInKind(kind) || isMidiOutKind(kind);
}

export function isMidiInOutput(name: string): name is MidiInOutput {
  return (MIDI_IN_OUTPUTS as readonly string[]).includes(name);
}

export function isMidiOutInput(name: string): name is MidiOutInput {
  return (MIDI_OUT_INPUTS as readonly string[]).includes(name);
}

/** Pitch, velocity, and CC live in the analyser mean. Peak is clamped to 1. */
export function midiInletValue(jack: { mean: number } | undefined): number {
  return jack?.mean ?? 0;
}

/** Gate and trig. A one-sample pulse may only show up as peak or pulse. */
export function midiInletGate(jack: { mean: number; peak: number; pulse?: boolean } | undefined): number {
  if (!jack) return 0;
  return jack.mean > 0.5 || jack.peak > 0.5 || jack.pulse ? 1 : 0;
}

export function voltsFromMidi(note: number): number {
  return (note - A4_MIDI) / 12;
}

export function midiFromVolts(cv: number): number {
  return clampMidi(Math.round(A4_MIDI + cv * 12));
}

export function clampMidi(note: number): number {
  if (!Number.isFinite(note)) return 0;
  return Math.max(0, Math.min(127, Math.round(note)));
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function midi7(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return Math.max(0, Math.min(127, Math.round(value)));
  return Math.max(0, Math.min(127, Math.round(value * 127)));
}

export function midiChannelByte(channel: number): number {
  const n = Math.round(channel);
  if (n <= 0) return 0;
  return Math.max(0, Math.min(15, n - 1));
}

/** Input 0 is omni. 1..16 is MIDI channel. Anything else is omni. */
export function midiInputChannel(channel: number): number {
  const n = Math.round(channel);
  if (n >= 1 && n <= 16) return n;
  return 0;
}

export function midiOutputChannel(channel: number): number {
  const n = Math.round(channel);
  if (n >= 1 && n <= 16) return n;
  return 1;
}

export function midiMessageIndex(value: number): number {
  const n = Math.round(value);
  if (n < 0) return 0;
  if (n >= MIDI_MESSAGE_NAMES.length) return 0;
  return n;
}

export interface MidiPortInfo {
  id: string;
  name: string;
  direction: 'input' | 'output';
}

export interface MidiIoFields {
  /** Host-local port id. Not session state. */
  deviceId: string | null;
  channel: number;
  message: number;
  cc: number;
  widthSec: number;
}

export const DEFAULT_MIDI_IN_FIELDS: MidiIoFields = {
  deviceId: null,
  channel: 0,
  message: 0,
  cc: 1,
  widthSec: 0.05,
};

export const DEFAULT_MIDI_OUT_FIELDS: MidiIoFields = {
  deviceId: null,
  channel: 1,
  message: 0,
  cc: 1,
  widthSec: 0.05,
};

function num(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function readMidiIoFields(
  data: Record<string, unknown> | undefined,
  fallback: MidiIoFields,
): MidiIoFields {
  const device = data?.deviceId;
  return {
    deviceId: typeof device === 'string' && device.length > 0 ? device : null,
    channel: num(data?.channel, fallback.channel),
    message: midiMessageIndex(num(data?.message, fallback.message)),
    cc: clampMidi(num(data?.cc, fallback.cc)),
    widthSec: Math.max(0, num(data?.widthSec, fallback.widthSec)),
  };
}

export type MidiVoiceEvent =
  | { type: 'noteOn'; note: number; velocity: number }
  | { type: 'noteOff'; note: number }
  | { type: 'cc'; cc: number; value: number }
  | { type: 'program'; program: number };

export interface MidiOutputSample {
  note: number;
  cv: number;
  gate: number;
  trig: number;
  velocity: number;
  cc: number;
}

export interface MidiOutputCables {
  note: boolean;
  cv: boolean;
  gate: boolean;
  trig: boolean;
  velocity: boolean;
  cc: boolean;
}

export interface MidiOutputState {
  prevGate: boolean;
  prevTrig: boolean;
  sounding: number | null;
  lastPitch: number;
  lastCc: number;
  offIn: number | null;
}

export function createMidiOutputState(): MidiOutputState {
  return {
    prevGate: false,
    prevTrig: false,
    sounding: null,
    lastPitch: 60,
    lastCc: -1,
    offIn: null,
  };
}

export function resolveMidiPitch(
  sample: MidiOutputSample,
  cables: MidiOutputCables,
  lastPitch: number,
): number {
  if (cables.note) return clampMidi(sample.note);
  if (cables.cv) return midiFromVolts(sample.cv);
  return lastPitch;
}

/**
 * One control tick of a MIDI Out node.
 *
 * Gate is the held voice: rise sends Note On, fall sends Note Off, a pitch
 * change while held re-articulates. Trig is the event: a pulse from a
 * looper or clock fires Note On. If gate is also patched, trig retriggers
 * only while gate is high and gate still owns the length. If gate is not
 * patched, the note ends on trig fall or after widthSec, whichever is later,
 * so a one-sample pulse still produces a MIDI note a synth can hear.
 */
export function stepMidiOutput(
  sample: MidiOutputSample,
  cables: MidiOutputCables,
  fields: MidiIoFields,
  state: MidiOutputState,
  dtSec: number,
): MidiVoiceEvent[] {
  const events: MidiVoiceEvent[] = [];
  const message = midiMessageIndex(fields.message);
  const pitch = resolveMidiPitch(sample, cables, state.lastPitch);
  state.lastPitch = pitch;
  const velocity = cables.velocity ? clamp01(sample.velocity) : 0.85;
  const gateHigh = cables.gate && sample.gate > 0.5;
  const trigHigh = cables.trig && sample.trig > 0.5;
  const gateRise = gateHigh && !state.prevGate;
  const gateFall = !gateHigh && state.prevGate;
  const trigRise = trigHigh && !state.prevTrig;
  const trigFall = !trigHigh && state.prevTrig;
  const width = fields.widthSec > 0 ? fields.widthSec : 0.05;

  const noteOn = (note: number, vel: number) => {
    events.push({ type: 'noteOn', note, velocity: vel });
    state.sounding = note;
  };
  const noteOff = (note: number) => {
    events.push({ type: 'noteOff', note });
    if (state.sounding === note) state.sounding = null;
    state.offIn = null;
  };

  if (message === 1) {
    const value = midi7(cables.cc ? sample.cc : cables.velocity ? sample.velocity : 0);
    if (trigRise || value !== state.lastCc) {
      events.push({ type: 'cc', cc: clampMidi(fields.cc), value });
      state.lastCc = value;
    }
  } else if (message === 2) {
    if (trigRise || gateRise) {
      const program = cables.cc ? midi7(sample.cc) : pitch;
      events.push({ type: 'program', program: clampMidi(program) });
    }
  } else if (cables.gate) {
    if (gateRise) noteOn(pitch, velocity);
    else if (gateFall && state.sounding != null) noteOff(state.sounding);
    else if (gateHigh && state.sounding != null && pitch !== state.sounding) {
      noteOff(state.sounding);
      noteOn(pitch, velocity);
    }
    if (trigRise && gateHigh) {
      if (state.sounding != null) noteOff(state.sounding);
      noteOn(pitch, velocity);
    }
  } else if (cables.trig) {
    if (trigRise) {
      if (state.sounding != null) noteOff(state.sounding);
      noteOn(pitch, velocity);
      state.offIn = width;
    }
    if (trigFall && state.sounding != null) {
      if (state.offIn == null || state.offIn <= 0) noteOff(state.sounding);
    }
    if (state.offIn != null && state.sounding != null) {
      state.offIn -= Math.max(0, dtSec);
      if (state.offIn <= 0 && !trigHigh) noteOff(state.sounding);
    }
  }

  state.prevGate = gateHigh;
  state.prevTrig = trigHigh;
  return events;
}

export function encodeMidiVoiceEvent(event: MidiVoiceEvent, channel: number): Uint8Array {
  const ch = midiChannelByte(channel);
  if (event.type === 'noteOn') {
    const vel = Math.max(1, midi7(event.velocity));
    return Uint8Array.from([0x90 | ch, event.note, vel]);
  }
  if (event.type === 'noteOff') return Uint8Array.from([0x80 | ch, event.note, 64]);
  if (event.type === 'cc') return Uint8Array.from([0xb0 | ch, event.cc, event.value]);
  return Uint8Array.from([0xc0 | ch, event.program]);
}

export type MidiInputEvent =
  | { type: 'noteOn'; note: number; velocity: number; channel: number }
  | { type: 'noteOff'; note: number; channel: number }
  | { type: 'cc'; cc: number; value: number; channel: number }
  | { type: 'program'; program: number; channel: number }
  | { type: 'allNotesOff'; channel: number };

/** Channel 0 is omni. Missing or short packets are ignored. */
export function parseMidiBytes(data: Uint8Array, channel = 0): MidiInputEvent | null {
  if (data.length < 2) return null;
  const status = data[0]!;
  const cmd = status & 0xf0;
  const src = (status & 0x0f) + 1;
  if (channel >= 1 && src !== channel) return null;
  const d1 = data[1]!;
  const d2 = data[2] ?? 0;
  if (cmd === 0x90 && d2 > 0) {
    return { type: 'noteOn', note: clampMidi(d1), velocity: d2 / 127, channel: src };
  }
  if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
    return { type: 'noteOff', note: clampMidi(d1), channel: src };
  }
  if (cmd === 0xb0 && d1 === 123) return { type: 'allNotesOff', channel: src };
  if (cmd === 0xb0) return { type: 'cc', cc: clampMidi(d1), value: d2, channel: src };
  if (cmd === 0xc0) return { type: 'program', program: clampMidi(d1), channel: src };
  return null;
}

export interface MidiInputSnapshot {
  note: number;
  velocity: number;
  gate: number;
  cv: number;
  cc: number;
  held: number[];
}

export class MidiInputMonitor {
  private readonly stack: Array<{ note: number; velocity: number }> = [];
  lastNote = 60;
  lastVelocity = 0.85;
  lastCc = 0;

  apply(event: MidiInputEvent): { type: 'press' | 'release'; note: number; velocity: number } | null {
    if (event.type === 'noteOn') {
      const existing = this.stack.findIndex((key) => key.note === event.note);
      if (existing >= 0) this.stack.splice(existing, 1);
      this.stack.push({ note: event.note, velocity: event.velocity });
      this.lastNote = event.note;
      this.lastVelocity = event.velocity;
      return { type: 'press', note: event.note, velocity: event.velocity };
    }
    if (event.type === 'noteOff') {
      const index = this.stack.findIndex((key) => key.note === event.note);
      if (index < 0) return null;
      this.stack.splice(index, 1);
      const top = this.stack[this.stack.length - 1];
      this.lastNote = top?.note ?? event.note;
      if (top) this.lastVelocity = top.velocity;
      return { type: 'release', note: event.note, velocity: this.lastVelocity };
    }
    if (event.type === 'cc') {
      this.lastCc = event.value / 127;
      return null;
    }
    if (event.type === 'allNotesOff') {
      this.stack.length = 0;
      return null;
    }
    return null;
  }

  get snapshot(): MidiInputSnapshot {
    const top = this.stack[this.stack.length - 1];
    const note = top?.note ?? this.lastNote;
    const velocity = top?.velocity ?? this.lastVelocity;
    return {
      note,
      velocity,
      gate: this.stack.length > 0 ? 1 : 0,
      cv: voltsFromMidi(note),
      cc: this.lastCc,
      held: this.stack.map((key) => key.note),
    };
  }
}
