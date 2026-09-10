let nextMidiClipId = 1;

export interface MidiNote {
  pitch: number;
  velocity: number;
  startBeat: number;
  durationBeats: number;
  channel?: number;
  repeatCount?: number;
  repeatSpacing?: number;
  ccEvents?: MidiCcEvent[];
}

export interface MidiCcEvent {
  cc: number;
  value: number;
}

export interface MidiCcPoint {
  startBeat: number;
  value: number;
}

export interface MidiCcLane {
  cc: number;
  channel: number;
  points: MidiCcPoint[];
}

export interface MidiClipOptions {
  notes: MidiNote[];
  name?: string;
  bars?: number;
  ccLanes?: MidiCcLane[];
}

export function midiVelocity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return Math.min(1, Math.max(0, value / 127));
  return Math.min(1, Math.max(0, value));
}

export function midiCcValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(127, Math.round(value)));
}

export function expandMidiNotes(notes: readonly MidiNote[]): MidiNote[] {
  const out: MidiNote[] = [];
  for (const note of notes) {
    const times = Math.max(1, note.repeatCount ?? 1);
    const spacing = note.repeatSpacing ?? note.durationBeats;
    for (let i = 0; i < times; i++) {
      out.push({ ...note, startBeat: note.startBeat + i * spacing });
    }
  }
  return out;
}

export class MidiClip {
  readonly id: number = nextMidiClipId++;
  name: string;
  notes: MidiNote[];
  bars: number;
  ccLanes: MidiCcLane[];

  constructor(options: MidiClipOptions) {
    this.notes = options.notes.map((note) => ({
      ...note,
      ccEvents: note.ccEvents?.map((event) => ({ ...event })),
    }));
    this.name = options.name ?? `MIDI ${this.id}`;
    this.bars = options.bars != null && options.bars > 0 ? options.bars : 0;
    this.ccLanes = (options.ccLanes ?? []).map((lane) => ({
      cc: lane.cc,
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
}
