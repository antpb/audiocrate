import { describe, expect, it } from 'vitest';
import {
  MidiInputMonitor,
  clampMidi,
  createMidiOutputState,
  encodeMidiVoiceEvent,
  midiFromVolts,
  midiInletGate,
  midiInletValue,
  parseMidiBytes,
  readMidiIoFields,
  resolveMidiPitch,
  stepMidiOutput,
  voltsFromMidi,
  type MidiOutputCables,
  type MidiOutputSample,
} from '../../src/midi/midiIo';

const noteCables: MidiOutputCables = {
  note: true,
  cv: false,
  gate: false,
  trig: true,
  velocity: true,
  cc: false,
};

const gateCables: MidiOutputCables = {
  note: true,
  cv: false,
  gate: true,
  trig: false,
  velocity: true,
  cc: false,
};

function sample(partial: Partial<MidiOutputSample> = {}): MidiOutputSample {
  return {
    note: 60,
    cv: 0,
    gate: 0,
    trig: 0,
    velocity: 0.8,
    cc: 0,
    ...partial,
  };
}

const fields = {
  deviceId: null,
  channel: 1,
  message: 0,
  cc: 1,
  widthSec: 0.05,
};

describe('MIDI pitch', () => {
  it('treats A4 as 0V', () => {
    expect(voltsFromMidi(69)).toBe(0);
    expect(midiFromVolts(0)).toBe(69);
    expect(midiFromVolts(-0.75)).toBe(60);
  });

  it('prefers the note inlet over 1V/oct when both are patched', () => {
    expect(
      resolveMidiPitch(sample({ note: 64, cv: 0 }), { ...noteCables, cv: true, trig: false }, 60),
    ).toBe(64);
  });

  it('reads 1V/oct when note is not patched', () => {
    expect(
      resolveMidiPitch(sample({ cv: 1 }), { ...noteCables, note: false, cv: true, trig: false }, 60),
    ).toBe(81);
  });
});

describe('stepMidiOutput notes', () => {
  it('turns a pulse plus a note into Note On, then Note Off after widthSec', () => {
    const state = createMidiOutputState();
    const on = stepMidiOutput(sample({ note: 64, trig: 1, velocity: 0.5 }), noteCables, fields, state, 1 / 48_000);
    expect(on).toEqual([{ type: 'noteOn', note: 64, velocity: 0.5 }]);
    const silent = stepMidiOutput(sample({ note: 64, trig: 0, velocity: 0.5 }), noteCables, fields, state, 0.02);
    expect(silent).toEqual([]);
    const off = stepMidiOutput(sample({ note: 64, trig: 0, velocity: 0.5 }), noteCables, fields, state, 0.04);
    expect(off).toEqual([{ type: 'noteOff', note: 64 }]);
  });

  it('lets a held gate own note length', () => {
    const state = createMidiOutputState();
    const on = stepMidiOutput(sample({ note: 60, gate: 1 }), gateCables, fields, state, 0.01);
    expect(on[0]).toMatchObject({ type: 'noteOn', note: 60 });
    expect(stepMidiOutput(sample({ note: 60, gate: 1 }), gateCables, fields, state, 0.2)).toEqual([]);
    const off = stepMidiOutput(sample({ note: 60, gate: 0 }), gateCables, fields, state, 0.01);
    expect(off).toEqual([{ type: 'noteOff', note: 60 }]);
  });

  it('re-articulates when pitch changes while gate is high', () => {
    const state = createMidiOutputState();
    stepMidiOutput(sample({ note: 60, gate: 1 }), gateCables, fields, state, 0.01);
    const next = stepMidiOutput(sample({ note: 64, gate: 1 }), gateCables, fields, state, 0.01);
    expect(next).toEqual([
      { type: 'noteOff', note: 60 },
      { type: 'noteOn', note: 64, velocity: 0.8 },
    ]);
  });

  it('retriggers from a pulse only while gate is high', () => {
    const cables: MidiOutputCables = { ...gateCables, trig: true };
    const state = createMidiOutputState();
    stepMidiOutput(sample({ note: 60, gate: 1, trig: 0 }), cables, fields, state, 0.01);
    const retrig = stepMidiOutput(sample({ note: 60, gate: 1, trig: 1 }), cables, fields, state, 0.01);
    expect(retrig).toEqual([
      { type: 'noteOff', note: 60 },
      { type: 'noteOn', note: 60, velocity: 0.8 },
    ]);
    const ignored = stepMidiOutput(sample({ note: 60, gate: 0, trig: 0 }), cables, fields, state, 0.01);
    expect(ignored).toEqual([{ type: 'noteOff', note: 60 }]);
    const whileLow = stepMidiOutput(sample({ note: 60, gate: 0, trig: 1 }), cables, fields, state, 0.01);
    expect(whileLow).toEqual([]);
  });

  it('keeps a held trig sounding past widthSec until the trig falls', () => {
    const state = createMidiOutputState();
    stepMidiOutput(sample({ note: 72, trig: 1 }), noteCables, fields, state, 0.001);
    expect(stepMidiOutput(sample({ note: 72, trig: 1 }), noteCables, fields, state, 0.2)).toEqual([]);
    const off = stepMidiOutput(sample({ note: 72, trig: 0 }), noteCables, fields, state, 0.001);
    expect(off).toEqual([{ type: 'noteOff', note: 72 }]);
  });
});

describe('stepMidiOutput CC and program', () => {
  it('sends CC when the value changes', () => {
    const state = createMidiOutputState();
    const cables: MidiOutputCables = { ...noteCables, trig: false, cc: true, note: false };
    const ccFields = { ...fields, message: 1, cc: 74 };
    const first = stepMidiOutput(sample({ cc: 0.5 }), cables, ccFields, state, 0.01);
    expect(first).toEqual([{ type: 'cc', cc: 74, value: 64 }]);
    expect(stepMidiOutput(sample({ cc: 0.5 }), cables, ccFields, state, 0.01)).toEqual([]);
  });

  it('sends program change on a trig', () => {
    const state = createMidiOutputState();
    const cables: MidiOutputCables = { ...noteCables, velocity: false };
    const prog = { ...fields, message: 2 };
    const events = stepMidiOutput(sample({ note: 12, trig: 1 }), cables, prog, state, 0.01);
    expect(events).toEqual([{ type: 'program', program: 12 }]);
  });
});

describe('parseMidiBytes', () => {
  it('filters by channel and maps note-on velocity to 0..1', () => {
    expect(parseMidiBytes(Uint8Array.from([0x91, 64, 100]), 2)).toMatchObject({
      type: 'noteOn',
      note: 64,
      velocity: expect.closeTo(100 / 127),
      channel: 2,
    });
    expect(parseMidiBytes(Uint8Array.from([0x91, 64, 100]), 1)).toBeNull();
    expect(parseMidiBytes(Uint8Array.from([0x80, 64, 0]), 0)?.type).toBe('noteOff');
  });

  it('treats note-on velocity 0 as note-off', () => {
    expect(parseMidiBytes(Uint8Array.from([0x90, 60, 0]))).toEqual({
      type: 'noteOff',
      note: 60,
      channel: 1,
    });
  });
});

describe('MidiInputMonitor', () => {
  it('is last-note like the Keyboard, and keeps CV after release', () => {
    const mon = new MidiInputMonitor();
    mon.apply({ type: 'noteOn', note: 60, velocity: 0.4, channel: 1 });
    mon.apply({ type: 'noteOn', note: 64, velocity: 0.9, channel: 1 });
    expect(mon.snapshot.note).toBe(64);
    expect(mon.snapshot.gate).toBe(1);
    expect(mon.snapshot.held).toEqual([60, 64]);
    mon.apply({ type: 'noteOff', note: 64, channel: 1 });
    expect(mon.snapshot.note).toBe(60);
    expect(mon.snapshot.cv).toBe(voltsFromMidi(60));
    mon.apply({ type: 'noteOff', note: 60, channel: 1 });
    expect(mon.snapshot.gate).toBe(0);
    expect(mon.snapshot.note).toBe(60);
  });
});

describe('encodeMidiVoiceEvent', () => {
  it('writes channel 3 note-on', () => {
    expect([...encodeMidiVoiceEvent({ type: 'noteOn', note: 64, velocity: 1 }, 3)]).toEqual([0x92, 64, 127]);
  });
});

describe('readMidiIoFields', () => {
  it('keeps a host device id as a string', () => {
    const fields = readMidiIoFields({ deviceId: 'port-2', channel: 4, message: 1, cc: 74, widthSec: 0.1 }, {
      deviceId: null,
      channel: 1,
      message: 0,
      cc: 1,
      widthSec: 0.05,
    });
    expect(fields.deviceId).toBe('port-2');
    expect(fields.channel).toBe(4);
    expect(clampMidi(200)).toBe(127);
  });
});

describe('midi inlet levels', () => {
  it('reads MIDI numbers from mean, and gates from peak or pulse', () => {
    expect(midiInletValue({ mean: 64 })).toBe(64);
    expect(midiInletGate({ mean: 0, peak: 1, pulse: false })).toBe(1);
    expect(midiInletGate({ mean: 0, peak: 0, pulse: true })).toBe(1);
    expect(midiInletGate({ mean: 0, peak: 0.01, pulse: false })).toBe(0);
  });
});
