import { MidiClip, type MidiCcLane, type MidiNote } from '../graph/MidiClip';
import { listenMidiInput, midiPortValues } from '../midi/webMidi';

export interface MidiFileTrack {
  name: string;
  notes: MidiNote[];
  ccLanes?: MidiCcLane[];
}

export interface MidiFile {
  format: number;
  ticksPerQuarter: number;
  tracks: MidiFileTrack[];
  tempoBpm: number;
  timeSigN: number;
  timeSigD: number;
}

export interface WebMidiInputLike {
  id: string;
  name?: string;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

export interface WebMidiAccessLike {
  inputs: Iterable<WebMidiInputLike>;
}

export interface WebMidiTarget {
  noteOn(note: number, options?: { velocity?: number }): void;
  noteOff(note: number): void;
  allNotesOff?(): void;
  controlChange?(cc: number, value: number): void;
}

export interface WebMidiBridge {
  connect(target: WebMidiTarget): Promise<void>;
  disconnect(): void;
  get connected(): boolean;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function readVLQ(view: DataView, offset: number): { value: number; next: number } {
  let value = 0;
  let i = offset;
  for (let n = 0; n < 4; n++) {
    if (i >= view.byteLength) throw new RangeError('decodeMidi: truncated variable-length quantity');
    const b = view.getUint8(i++);
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return { value, next: i };
  }
  throw new RangeError('decodeMidi: variable-length quantity longer than 4 bytes');
}

function writeVLQ(value: number): number[] {
  const out = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return out;
}

function ticksToBeats(ticks: number, tpq: number): number {
  return tpq > 0 ? ticks / tpq : 0;
}

function parseTrack(view: DataView, start: number, length: number, tpq: number): {
  track: MidiFileTrack;
  tempoBpm?: number;
  timeSigN?: number;
  timeSigD?: number;
} {
  const end = start + length;
  let offset = start;
  let tick = 0;
  let running = 0;
  let name = '';
  let tempoBpm: number | undefined;
  let timeSigN: number | undefined;
  let timeSigD: number | undefined;
  const ons = new Map<string, Array<{ tick: number; velocity: number }>>();
  const notes: MidiNote[] = [];
  const ccByKey = new Map<string, MidiCcLane>();

  const pushNote = (channel: number, pitch: number, endTick: number) => {
    const key = `${channel}:${pitch}`;
    const stack = ons.get(key);
    const on = stack?.shift();
    if (!on) return;
    notes.push({
      pitch,
      velocity: on.velocity,
      startBeat: ticksToBeats(on.tick, tpq),
      durationBeats: Math.max(0, ticksToBeats(endTick - on.tick, tpq)),
      channel,
    });
  };

  while (offset < end) {
    const delta = readVLQ(view, offset);
    offset = delta.next;
    tick += delta.value;
    if (offset >= end) break;
    const first = view.getUint8(offset);
    let status: number;
    if (first < 0x80) {
      if (running === 0) throw new TypeError('decodeMidi: running status with no previous status');
      status = running;
    } else {
      status = first;
      offset += 1;
      if (first < 0xf0) running = first;
    }

    if (status === 0xff) {
      if (offset >= end) break;
      const type = view.getUint8(offset++);
      const len = readVLQ(view, offset);
      offset = len.next;
      const dataStart = offset;
      offset += len.value;
      if (type === 0x2f) break;
      if (type === 0x03 && len.value > 0) {
        name = readAscii(view, dataStart, len.value);
      }
      if (type === 0x51 && len.value >= 3) {
        const us = (view.getUint8(dataStart) << 16) | (view.getUint8(dataStart + 1) << 8) | view.getUint8(dataStart + 2);
        if (us > 0) tempoBpm = 60_000_000 / us;
      }
      if (type === 0x58 && len.value >= 2) {
        timeSigN = view.getUint8(dataStart);
        timeSigD = 2 ** view.getUint8(dataStart + 1);
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const len = readVLQ(view, offset);
      offset = len.next + len.value;
      running = 0;
      continue;
    }

    const cmd = status & 0xf0;
    const channel = status & 0x0f;
    if (cmd === 0xc0 || cmd === 0xd0) {
      offset += 1;
      continue;
    }
    if (offset + 1 >= view.byteLength) break;
    const d1 = view.getUint8(offset++);
    const d2 = cmd === 0xf0 ? 0 : view.getUint8(offset++);
    if (cmd === 0x90 && d2 > 0) {
      const key = `${channel}:${d1}`;
      const stack = ons.get(key) ?? [];
      stack.push({ tick, velocity: d2 });
      ons.set(key, stack);
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      pushNote(channel, d1, tick);
    } else if (cmd === 0xb0 && d1 !== 123) {
      const key = `${channel}:${d1}`;
      const lane = ccByKey.get(key) ?? { cc: d1, channel, points: [] };
      lane.points.push({ startBeat: ticksToBeats(tick, tpq), value: d2 });
      ccByKey.set(key, lane);
    }
  }

  notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  const ccLanes = [...ccByKey.values()];
  return { track: { name: name || 'Track', notes, ccLanes: ccLanes.length > 0 ? ccLanes : undefined }, tempoBpm, timeSigN, timeSigD };
}

/**
 * Standard MIDI File Type 0 / 1. Metrical time only
 * (ticks per quarter). SMPTE division is rejected. Takes already-read
 * bytes so Node, fetch, and dropped files share one decoder.
 */
export function decodeMidi(bytes: Uint8Array): MidiFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 14 || readAscii(view, 0, 4) !== 'MThd') {
    throw new TypeError('decodeMidi: not a Standard MIDI File');
  }
  const headerLen = view.getUint32(4);
  const format = view.getUint16(8);
  const ntrks = view.getUint16(10);
  const division = view.getUint16(12);
  if (division & 0x8000) {
    throw new TypeError('decodeMidi: SMPTE division is not supported');
  }
  const ticksPerQuarter = division;
  let offset = 8 + headerLen;
  const tracks: MidiFileTrack[] = [];
  let tempoBpm = 120;
  let timeSigN = 4;
  let timeSigD = 4;
  for (let i = 0; i < ntrks && offset + 8 <= view.byteLength; i++) {
    if (readAscii(view, offset, 4) !== 'MTrk') {
      throw new TypeError(`decodeMidi: expected MTrk at track ${i}`);
    }
    const len = view.getUint32(offset + 4);
    const parsed = parseTrack(view, offset + 8, len, ticksPerQuarter);
    tracks.push(parsed.track);
    if (parsed.tempoBpm != null) tempoBpm = parsed.tempoBpm;
    if (parsed.timeSigN != null) timeSigN = parsed.timeSigN;
    if (parsed.timeSigD != null) timeSigD = parsed.timeSigD;
    offset += 8 + len;
  }
  return {
    format,
    ticksPerQuarter,
    tracks,
    tempoBpm,
    timeSigN,
    timeSigD,
  };
}

function collectEvents(track: MidiFileTrack, tpq: number): Array<{ tick: number; bytes: number[] }> {
  const events: Array<{ tick: number; bytes: number[] }> = [];
  if (track.name) {
    const nameBytes = Array.from(track.name).map((c) => c.charCodeAt(0) & 0x7f);
    events.push({ tick: 0, bytes: [0xff, 0x03, ...writeVLQ(nameBytes.length), ...nameBytes] });
  }
  for (const note of track.notes) {
    const start = Math.max(0, Math.round(note.startBeat * tpq));
    const end = Math.max(start, Math.round((note.startBeat + Math.max(0, note.durationBeats)) * tpq));
    const channel = Math.max(0, Math.min(15, note.channel ?? 0));
    const pitch = Math.max(0, Math.min(127, note.pitch | 0));
    const vel = Math.max(1, Math.min(127, note.velocity > 1 ? note.velocity | 0 : Math.round(note.velocity * 127) || 64));
    events.push({ tick: start, bytes: [0x90 | channel, pitch, vel] });
    events.push({ tick: end, bytes: [0x80 | channel, pitch, 64] });
  }
  events.sort((a, b) => a.tick - b.tick);
  events.push({ tick: events.length ? events[events.length - 1]!.tick : 0, bytes: [0xff, 0x2f, 0x00] });
  return events;
}

export function encodeMidi(file: MidiFile): Uint8Array {
  const tpq = file.ticksPerQuarter > 0 ? file.ticksPerQuarter : 480;
  const tracks = file.tracks.length > 0 ? file.tracks : [{ name: 'Track', notes: [] }];
  const chunks: number[] = [];
  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, tracks.length > 1 ? 1 : 0,
    (tracks.length >> 8) & 0xff,
    tracks.length & 0xff,
    (tpq >> 8) & 0xff,
    tpq & 0xff,
  ];
  chunks.push(...header);
  for (const track of tracks) {
    const events = collectEvents(track, tpq);
    const body: number[] = [];
    let lastTick = 0;
    for (const event of events) {
      body.push(...writeVLQ(Math.max(0, event.tick - lastTick)));
      body.push(...event.bytes);
      lastTick = event.tick;
    }
    chunks.push(0x4d, 0x54, 0x72, 0x6b);
    chunks.push((body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff);
    chunks.push(...body);
  }
  return new Uint8Array(chunks);
}

export function midiFileToClips(file: MidiFile): MidiClip[] {
  return file.tracks
    .filter((track) => track.notes.length > 0 || (track.ccLanes?.length ?? 0) > 0)
    .map((track) => new MidiClip({ name: track.name, notes: track.notes, ccLanes: track.ccLanes }));
}

function defaultRequestMIDIAccess(): Promise<WebMidiAccessLike> {
  const nav = globalThis as { navigator?: { requestMIDIAccess?: () => Promise<WebMidiAccessLike> } };
  if (!nav.navigator?.requestMIDIAccess) {
    throw new Error('Web MIDI is not available in this environment');
  }
  return nav.navigator.requestMIDIAccess();
}

/**
 * Live hardware bridge. Inject `requestMIDIAccess` in tests. Never reads
 * `window` as a singleton; the default looks up `navigator` on globalThis.
 */
export function createWebMidiBridge(options: {
  requestMIDIAccess?: () => Promise<WebMidiAccessLike>;
} = {}): WebMidiBridge {
  const request = options.requestMIDIAccess ?? defaultRequestMIDIAccess;
  let inputs: WebMidiInputLike[] = [];
  let unsubs: Array<() => void> = [];
  let target: WebMidiTarget | null = null;

  const onMessage = (event: { data: Uint8Array }) => {
    if (!target || event.data.length < 2) return;
    const status = event.data[0]!;
    const cmd = status & 0xf0;
    const d1 = event.data[1]!;
    const d2 = event.data[2] ?? 0;
    if (cmd === 0x90 && d2 > 0) target.noteOn(d1, { velocity: d2 / 127 });
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) target.noteOff(d1);
    else if (cmd === 0xb0 && d1 === 123) target.allNotesOff?.();
    else if (cmd === 0xb0) target.controlChange?.(d1, d2);
  };

  return {
    async connect(next: WebMidiTarget) {
      this.disconnect();
      target = next;
      const access = await request();
      inputs = midiPortValues(access.inputs);
      for (const input of inputs) unsubs.push(listenMidiInput(input, (data) => onMessage({ data })));
    },
    disconnect() {
      for (const off of unsubs) off();
      unsubs = [];
      inputs = [];
      target = null;
    },
    get connected() {
      return target != null;
    },
  };
}

export const MidiLoader = {
  decode: decodeMidi,
  encode: encodeMidi,
  toClips: midiFileToClips,
  createBridge: createWebMidiBridge,
};
