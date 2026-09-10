import { midiVelocity, noteName } from '../../src/index';
import type { PatchMidiNote } from './patch';

export interface MidiClipFields {
  offsetSec: number;
  start: number;
  rate: number;
  transpose: number;
  velocity: number;
  loop: boolean;
  loops: number;
}

export interface MidiClipStats {
  notes: number;
  low: string | null;
  high: string | null;
  beats: number;
}

const emptyFields: MidiClipFields = {
  offsetSec: 0,
  start: 0,
  rate: 1,
  transpose: 0,
  velocity: 1,
  loop: false,
  loops: 4,
};

function num(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readMidiNotes(data: Record<string, unknown> | undefined): PatchMidiNote[] {
  if (!data || !Array.isArray(data.notes)) return [];
  const notes: PatchMidiNote[] = [];
  for (const raw of data.notes) {
    if (!raw || typeof raw !== 'object') continue;
    const note = raw as PatchMidiNote;
    if (typeof note.pitch !== 'number') continue;
    notes.push({
      pitch: note.pitch,
      startBeat: Number.isFinite(note.startBeat) ? note.startBeat : 0,
      durationBeats: Number.isFinite(note.durationBeats) ? note.durationBeats : 0.25,
      velocity: Number.isFinite(note.velocity) ? note.velocity : 0.85,
    });
  }
  return notes;
}

export function readMidiClipFields(data: Record<string, unknown> | undefined): MidiClipFields {
  const loops = Math.round(num(data?.loops, emptyFields.loops));
  return {
    offsetSec: Math.max(0, num(data?.offsetSec, 0)),
    start: clamp(num(data?.start, 0), 0, 1),
    rate: clamp(num(data?.rate, 1), 0.25, 4),
    transpose: Math.round(clamp(num(data?.transpose, 0), -12, 12)),
    velocity: clamp(num(data?.velocity, 1), 0, 2),
    loop: num(data?.loop, 0) >= 0.5,
    loops: clamp(loops, 1, 8),
  };
}

export function clipLengthBeats(notes: readonly PatchMidiNote[], bars: unknown): number {
  let end = 0;
  for (const note of notes) {
    const stop = note.startBeat + Math.max(0, note.durationBeats);
    if (stop > end) end = stop;
  }
  const barCount = num(bars, 0);
  if (barCount > 0) end = Math.max(end, barCount * 4);
  return end;
}

export function midiClipStats(notes: readonly PatchMidiNote[]): MidiClipStats {
  if (notes.length === 0) return { notes: 0, low: null, high: null, beats: 0 };
  let low = notes[0]!.pitch;
  let high = low;
  for (const note of notes) {
    if (note.pitch < low) low = note.pitch;
    if (note.pitch > high) high = note.pitch;
  }
  return {
    notes: notes.length,
    low: noteName(low),
    high: noteName(high),
    beats: clipLengthBeats(notes, 0),
  };
}

export function placeMidiClip(data: Record<string, unknown> | undefined): {
  notes: PatchMidiNote[];
  offsetSec: number;
} {
  const fields = readMidiClipFields(data);
  const source = readMidiNotes(data);
  const length = clipLengthBeats(source, data?.bars);
  const windowStart = fields.start * length;
  const windowLen = Math.max(0, length - windowStart);
  const cycles = fields.loop ? Math.max(1, fields.loops) : 1;
  const rate = fields.rate > 0 ? fields.rate : 1;
  const notes: PatchMidiNote[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const shift = cycle * windowLen;
    for (const note of source) {
      const rel = note.startBeat - windowStart;
      if (rel < -1e-6) continue;
      if (windowLen > 0 && rel >= windowLen - 1e-9) continue;
      notes.push({
        pitch: clamp(Math.round(note.pitch + fields.transpose), 0, 127),
        startBeat: (rel + shift) / rate,
        durationBeats: Math.max(0.02, note.durationBeats / rate),
        velocity: clamp(midiVelocity(note.velocity) * fields.velocity, 0, 1),
      });
    }
  }
  return { notes, offsetSec: fields.offsetSec };
}
