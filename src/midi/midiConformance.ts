/**
 * The MIDI host-jack conformance fixture, as a value.
 *
 * `asl/conformanceFixture.ts` keeps the two interpreters agreeing about
 * per-sample maths. This file does the same job one level up, for the part of
 * crate that is not DSP at all: the host jacks. MIDI In and MIDI Out are
 * AudioMaterial kinds handled in `patcher/flattenPatch.ts`, not ASL node kinds, so
 * nothing in the ASL fixture has ever been able to see them. The rules in
 * `midiIo.ts` (gate owns length, trig is the event, trig retriggers only
 * while gate is high) existed as prose in a handoff and as one implementation,
 * which is the arrangement that already let the Swift interpreter drift.
 *
 * Every expectation here is computed by running `midiIo.ts`, never typed by
 * hand. The inputs are authored; the outputs are recorded. That is what makes
 * this a description of the code rather than a second opinion about it, and
 * it is why `midiConformance.test.ts` can catch a semantics change the moment
 * the fixture is regenerated.
 *
 * Everything compared is an integer, a string, or a double produced by one
 * division of small integers. There is no tolerance and there should not be:
 * a MIDI byte is either 0x90 or it is not, and a note number that is off by
 * one is a wrong note rather than a rounding disagreement.
 */
import {
  DEFAULT_MIDI_IN_FIELDS,
  DEFAULT_MIDI_OUT_FIELDS,
  MIDI_IN_OUTPUTS,
  MIDI_MESSAGE_NAMES,
  MIDI_OUT_INPUTS,
  MidiInputMonitor,
  clamp01,
  clampMidi,
  encodeMidiVoiceEvent,
  midi7,
  midiChannelByte,
  midiFromVolts,
  midiInputChannel,
  midiMessageIndex,
  midiOutputChannel,
  parseMidiBytes,
  stepMidiOutput,
  voltsFromMidi,
  type MidiInputEvent,
  type MidiInputSnapshot,
  type MidiIoFields,
  type MidiOutputCables,
  type MidiOutputSample,
  createMidiOutputState,
} from './midiIo';
import {
  MIDI_TRIG_SECONDS,
  emptyMidiCables,
  emptyMidiSample,
  midiInOutlets,
  midiOutSample,
  type MidiInletReading,
} from './midiHostIo';
import { DEFAULT_PATCH_IO } from '../patcher/flattenPatch';

/**
 * Bumped when the shape changes, not when the rules do.
 *
 * A reader that does not understand the format must refuse the file. A Swift
 * suite that silently skipped a case family it had never heard of would
 * report full marks while checking a fraction of the contract, which is the
 * failure this whole file exists to prevent.
 *
 * 1: parse, monitor, output, encode, scalars, and the jack vocabulary.
 * 2: outlets and inlets, the host-graph layer around the convertor.
 */
export const MIDI_CONFORMANCE_FIXTURE_VERSION = 2;

export interface MidiParseCase {
  name: string;
  /** Raw packet as a host delivers it. */
  bytes: number[];
  /** 0 is omni, 1..16 filters. */
  channel: number;
  /** Null when the packet is filtered out, malformed, or not a kind we map. */
  event: MidiInputEvent | null;
}

export interface MidiMonitorStep {
  bytes: number[];
  snapshot: MidiInputSnapshot;
}

export interface MidiMonitorCase {
  name: string;
  channel: number;
  /** The snapshot after each packet, so ordering is asserted and not only the end. */
  steps: MidiMonitorStep[];
}

export interface MidiOutputTick {
  sample: MidiOutputSample;
  /** Event kinds this tick emitted, in order. */
  types: string[];
  /** The same events encoded on the case's channel. Integers, so exact. */
  bytes: number[][];
}

export interface MidiOutputCase {
  name: string;
  fields: MidiIoFields;
  cables: MidiOutputCables;
  dtSec: number;
  ticks: MidiOutputTick[];
}

export interface MidiEncodeCase {
  name: string;
  type: string;
  /** Note, cc, or program number depending on `type`. */
  a: number;
  /** Velocity (0..1) or CC value (0..127). Ignored for program. */
  b: number;
  channel: number;
  bytes: number[];
}

/** A MIDI In monitor snapshot, and the six outlet levels it produces. */
export interface MidiOutletCase {
  name: string;
  /** Null is "no device bound, nothing pressed yet". */
  snapshot: MidiInputSnapshot | null;
  levels: Record<string, number>;
}

/** Cabled inlets plus what the host read from each, and the tick they gather into. */
export interface MidiInletCase {
  name: string;
  cables: MidiOutputCables;
  readings: Record<string, MidiInletReading>;
  sample: MidiOutputSample;
}

export interface MidiScalarCase {
  fn: string;
  input: number;
  output: number;
}

export interface MidiConformanceFixture {
  note: string;
  version: number;
  /** FNV-1a over everything else. See `midiFixtureStamp`. */
  stamp: string;
  /**
   * The jack vocabulary, carried so the other implementation can check its own
   * against this one directly. The same argument as `kinds` in the ASL
   * fixture: a name added on one side and missed on the other is a cable that
   * silently goes nowhere, and a human diffing two lists is what this project
   * has already been burned by once.
   */
  inOutputs: string[];
  outInputs: string[];
  messageNames: string[];
  ioKinds: Record<string, string>;
  defaults: { midiIn: MidiIoFields; midiOut: MidiIoFields };
  /** Seconds a `trig` outlet stays high. An edge needs a width to be readable. */
  trigSeconds: number;
  /** An unpatched MIDI Out tick, which is not all zeroes. */
  emptySample: MidiOutputSample;
  outlets: MidiOutletCase[];
  inlets: MidiInletCase[];
  parse: MidiParseCase[];
  monitor: MidiMonitorCase[];
  output: MidiOutputCase[];
  encode: MidiEncodeCase[];
  scalars: MidiScalarCase[];
}

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CONTROL = 0xb0;
const PROGRAM = 0xc0;

/** Authored packets. The expectation for each is whatever `parseMidiBytes` says. */
const PARSE_INPUTS: Array<{ name: string; bytes: number[]; channel: number }> = [
  { name: 'note on, omni', bytes: [NOTE_ON, 60, 100], channel: 0 },
  { name: 'note on, matching channel', bytes: [NOTE_ON | 2, 60, 100], channel: 3 },
  { name: 'note on, wrong channel', bytes: [NOTE_ON | 2, 60, 100], channel: 5 },
  { name: 'note on velocity 0 is a note off', bytes: [NOTE_ON, 60, 0], channel: 0 },
  { name: 'note off', bytes: [NOTE_OFF, 60, 64], channel: 0 },
  { name: 'note off, running-status short packet', bytes: [NOTE_OFF, 60], channel: 0 },
  { name: 'cc', bytes: [CONTROL, 1, 64], channel: 0 },
  { name: 'cc 123 is all notes off', bytes: [CONTROL, 123, 0], channel: 0 },
  { name: 'program change', bytes: [PROGRAM, 7], channel: 0 },
  { name: 'one byte is not a message', bytes: [NOTE_ON], channel: 0 },
  { name: 'pitch bend is not mapped', bytes: [0xe0, 0, 64], channel: 0 },
  { name: 'clock is not mapped', bytes: [0xf8, 0], channel: 0 },
  { name: 'top channel 16 matches', bytes: [NOTE_ON | 15, 72, 1], channel: 16 },
];

/** Authored packet streams for the last-note monitor. */
const MONITOR_INPUTS: Array<{ name: string; channel: number; packets: number[][] }> = [
  {
    name: 'last note wins and CV survives release',
    channel: 0,
    packets: [
      [NOTE_ON, 60, 100],
      [NOTE_ON, 64, 80],
      [NOTE_OFF, 64, 64],
      [NOTE_OFF, 60, 64],
    ],
  },
  {
    name: 'releasing the top key falls back to the one still held',
    channel: 0,
    packets: [
      [NOTE_ON, 48, 127],
      [NOTE_ON, 55, 64],
      [NOTE_OFF, 55, 64],
      [NOTE_ON, 60, 32],
    ],
  },
  {
    name: 'the same note pressed twice is one entry',
    channel: 0,
    packets: [
      [NOTE_ON, 60, 100],
      [NOTE_ON, 60, 20],
      [NOTE_OFF, 60, 64],
    ],
  },
  {
    name: 'a note off nobody pressed changes nothing',
    channel: 0,
    packets: [
      [NOTE_ON, 60, 100],
      [NOTE_OFF, 72, 64],
    ],
  },
  {
    name: 'all notes off empties the stack and keeps the last pitch',
    channel: 0,
    packets: [
      [NOTE_ON, 60, 100],
      [NOTE_ON, 67, 100],
      [CONTROL, 123, 0],
    ],
  },
  {
    name: 'cc moves the cc outlet and nothing else',
    channel: 0,
    packets: [
      [NOTE_ON, 60, 100],
      [CONTROL, 1, 127],
      [CONTROL, 1, 0],
    ],
  },
];

function cables(patched: Partial<MidiOutputCables>): MidiOutputCables {
  return { ...emptyMidiCables(), ...patched };
}

function sample(values: Partial<MidiOutputSample>): MidiOutputSample {
  return { ...emptyMidiSample(), velocity: 0.8, ...values };
}

const OUT_FIELDS: MidiIoFields = { ...DEFAULT_MIDI_OUT_FIELDS, channel: 1 };

/**
 * Authored tick streams for the convertor.
 *
 * `dtSec` is a control tick, not a sample. The widthSec cases use 0.02 so a
 * 0.05 width expires on the third tick, which is short enough to read in a
 * fixture and long enough that an off-by-one in the countdown shows up.
 */
const OUTPUT_INPUTS: Array<{
  name: string;
  fields: MidiIoFields;
  cables: MidiOutputCables;
  dtSec: number;
  ticks: MidiOutputSample[];
}> = [
  {
    name: 'held gate owns note length',
    fields: OUT_FIELDS,
    cables: cables({ gate: true, note: true, velocity: true }),
    dtSec: 0.02,
    ticks: [
      sample({ gate: 0, note: 60 }),
      sample({ gate: 1, note: 60, velocity: 0.5 }),
      sample({ gate: 1, note: 60, velocity: 0.5 }),
      sample({ gate: 0, note: 60, velocity: 0.5 }),
    ],
  },
  {
    name: 'pitch change while gate is high re-articulates',
    fields: OUT_FIELDS,
    cables: cables({ gate: true, note: true }),
    dtSec: 0.02,
    ticks: [
      sample({ gate: 1, note: 60 }),
      sample({ gate: 1, note: 67 }),
      sample({ gate: 0, note: 67 }),
    ],
  },
  {
    name: 'trig retriggers only while gate is high',
    fields: OUT_FIELDS,
    cables: cables({ gate: true, trig: true, note: true }),
    dtSec: 0.02,
    ticks: [
      sample({ gate: 0, trig: 1, note: 60 }),
      sample({ gate: 1, trig: 0, note: 60 }),
      sample({ gate: 1, trig: 1, note: 60 }),
      sample({ gate: 1, trig: 0, note: 60 }),
      sample({ gate: 0, trig: 1, note: 60 }),
    ],
  },
  {
    name: 'a one-tick pulse still makes a note a synth can hear',
    fields: OUT_FIELDS,
    cables: cables({ trig: true, note: true }),
    dtSec: 0.02,
    ticks: [
      sample({ trig: 1, note: 62 }),
      sample({ trig: 0, note: 62 }),
      sample({ trig: 0, note: 62 }),
      sample({ trig: 0, note: 62 }),
      sample({ trig: 0, note: 62 }),
    ],
  },
  {
    name: 'a held trig outlives widthSec',
    fields: OUT_FIELDS,
    cables: cables({ trig: true, note: true }),
    dtSec: 0.02,
    ticks: [
      sample({ trig: 1, note: 62 }),
      sample({ trig: 1, note: 62 }),
      sample({ trig: 1, note: 62 }),
      sample({ trig: 1, note: 62 }),
      sample({ trig: 0, note: 62 }),
    ],
  },
  {
    name: 'cv drives pitch when note is not patched',
    fields: OUT_FIELDS,
    cables: cables({ gate: true, cv: true }),
    dtSec: 0.02,
    ticks: [
      sample({ gate: 1, cv: 0 }),
      sample({ gate: 1, cv: 1 }),
      sample({ gate: 0, cv: 1 }),
    ],
  },
  {
    name: 'no pitch cable holds the last pitch',
    fields: OUT_FIELDS,
    cables: cables({ gate: true }),
    dtSec: 0.02,
    ticks: [sample({ gate: 1 }), sample({ gate: 0 })],
  },
  {
    name: 'cc message sends on change and on a trig',
    fields: { ...OUT_FIELDS, message: 1, cc: 74 },
    cables: cables({ cc: true, trig: true }),
    dtSec: 0.02,
    ticks: [
      sample({ cc: 0, trig: 0 }),
      sample({ cc: 0.5, trig: 0 }),
      sample({ cc: 0.5, trig: 0 }),
      sample({ cc: 0.5, trig: 1 }),
    ],
  },
  {
    name: 'program change fires on a trig or a gate rise',
    fields: { ...OUT_FIELDS, message: 2 },
    cables: cables({ trig: true, note: true }),
    dtSec: 0.02,
    ticks: [
      sample({ trig: 1, note: 12 }),
      sample({ trig: 0, note: 12 }),
      sample({ trig: 1, note: 12 }),
    ],
  },
  {
    name: 'channel 10 lands on the drum channel byte',
    fields: { ...OUT_FIELDS, channel: 10 },
    cables: cables({ gate: true, note: true }),
    dtSec: 0.02,
    ticks: [sample({ gate: 1, note: 38 }), sample({ gate: 0, note: 38 })],
  },
  {
    name: 'velocity 0 still leaves an audible note on',
    fields: OUT_FIELDS,
    cables: cables({ gate: true, note: true, velocity: true }),
    dtSec: 0.02,
    ticks: [sample({ gate: 1, note: 60, velocity: 0 }), sample({ gate: 0, note: 60, velocity: 0 })],
  },
  {
    name: 'nothing patched emits nothing',
    fields: OUT_FIELDS,
    cables: cables({}),
    dtSec: 0.02,
    ticks: [sample({ gate: 1, trig: 1, note: 60 }), sample({ gate: 0, trig: 0, note: 60 })],
  },
];

/**
 * Snapshots a MIDI In node can be in. The nulls and the released cases matter
 * most: they are what a graph reads before anyone touches a key, and getting
 * `note` wrong there is an inaudible sub-bass C rather than middle C.
 */
const OUTLET_INPUTS: Array<{ name: string; snapshot: MidiInputSnapshot | null }> = [
  { name: 'no device bound', snapshot: null },
  {
    name: 'one key held',
    snapshot: { note: 60, velocity: 0.75, gate: 1, cv: voltsFromMidi(60), cc: 0, held: [60] },
  },
  {
    name: 'two keys held, top note wins',
    snapshot: { note: 67, velocity: 0.5, gate: 1, cv: voltsFromMidi(67), cc: 0.25, held: [60, 67] },
  },
  {
    name: 'all released, pitch and velocity survive',
    snapshot: { note: 67, velocity: 0.5, gate: 0, cv: voltsFromMidi(67), cc: 0.25, held: [] },
  },
  {
    name: 'low note, negative cv',
    snapshot: { note: 21, velocity: 1, gate: 1, cv: voltsFromMidi(21), cc: 1, held: [21] },
  },
];

function reading(mean: number, peak = mean, pulse = false): MidiInletReading {
  return { mean, peak, pulse };
}

/**
 * How a host's per-inlet readings gather into one convertor tick.
 *
 * The pulse cases are the reason this family exists. A looper wrap is one
 * sample wide; over a block its mean rounds to nothing and its peak can be
 * missed entirely, so the host reports it as `pulse` and the gate rule has to
 * honour that. A host that only looked at `mean` would drop every wrap.
 */
const INLET_INPUTS: Array<{
  name: string;
  cables: MidiOutputCables;
  readings: Record<string, MidiInletReading>;
}> = [
  { name: 'nothing cabled', cables: cables({}), readings: {} },
  {
    name: 'note and gate, held',
    cables: cables({ note: true, gate: true }),
    readings: { note: reading(64), gate: reading(1) },
  },
  {
    name: 'gate at zero is patched and off, not unpatched',
    cables: cables({ note: true, gate: true }),
    readings: { note: reading(64), gate: reading(0) },
  },
  {
    name: 'a one-sample pulse is only visible as pulse',
    cables: cables({ trig: true }),
    readings: { trig: reading(0.002, 0, true) },
  },
  {
    name: 'a one-sample pulse visible only as peak',
    cables: cables({ trig: true }),
    readings: { trig: reading(0.002, 1) },
  },
  {
    name: 'a gate at 0.6 is high and a gate at 0.4 is not',
    cables: cables({ gate: true }),
    readings: { gate: reading(0.6) },
  },
  {
    name: 'a gate at 0.4 is low',
    cables: cables({ gate: true }),
    readings: { gate: reading(0.4) },
  },
  {
    name: 'note is a value, not a gate',
    cables: cables({ note: true }),
    readings: { note: reading(127, 127) },
  },
  {
    name: 'a cabled inlet with no reading keeps the default',
    cables: cables({ note: true, velocity: true }),
    readings: {},
  },
  {
    name: 'a cabled inlet reading zero is zero, not the default',
    cables: cables({ note: true, velocity: true }),
    readings: { note: reading(0), velocity: reading(0) },
  },
  {
    name: 'a missing gate reading is low, same as the default',
    cables: cables({ gate: true, trig: true }),
    readings: {},
  },
  {
    name: 'cv, velocity and cc all read as values',
    cables: cables({ cv: true, velocity: true, cc: true }),
    readings: { cv: reading(-1.25), velocity: reading(0.3), cc: reading(0.9) },
  },
];

const ENCODE_INPUTS: Array<{ name: string; type: string; a: number; b: number; channel: number }> = [
  { name: 'note on, channel 1', type: 'noteOn', a: 60, b: 1, channel: 1 },
  { name: 'note on, channel 3', type: 'noteOn', a: 64, b: 0.5, channel: 3 },
  { name: 'note on, channel 16', type: 'noteOn', a: 127, b: 1, channel: 16 },
  { name: 'note on, velocity 0 becomes 1', type: 'noteOn', a: 60, b: 0, channel: 1 },
  { name: 'note off', type: 'noteOff', a: 60, b: 0, channel: 1 },
  { name: 'cc', type: 'cc', a: 74, b: 64, channel: 2 },
  { name: 'program', type: 'program', a: 7, b: 0, channel: 1 },
  { name: 'channel 0 clamps to the first channel', type: 'noteOn', a: 60, b: 1, channel: 0 },
  { name: 'channel 99 clamps to the last channel', type: 'noteOn', a: 60, b: 1, channel: 99 },
];

/**
 * Probes for the scalar conversions.
 *
 * No NaN or Infinity: JSON cannot carry either, and a fixture that quietly
 * turned them into null would be asserting something other than what it says.
 * The guards for those live in the unit tests on each side.
 */
const SCALAR_PROBES: Record<string, number[]> = {
  /**
   * The rounding rule itself, recorded directly.
   *
   * `Math.round` rounds half toward positive infinity, so -0.5 is -0 and
   * -1.5 is -1. Swift's `rounded()` rounds half away from zero, so the same
   * two inputs give -1 and -2. Every conversion below clamps at 0, which
   * means the disagreement is invisible in all of their outputs and a probe
   * on any of them proves nothing. It is a real difference between the two
   * languages sitting one clamp away from being audible, so it is asserted
   * here on its own rather than left to a helper nobody checks.
   */
  jsRound: [-59.5, -2.5, -1.5, -0.5, -0.4, 0, 0.4, 0.5, 1.5, 2.5, 59.5, 63.5],
  voltsFromMidi: [0, 57, 69, 81, 127],
  midiFromVolts: [-5.75, -1, 0, 0.5, 1, 4.9],
  clampMidi: [-10, -0.4, 0, 59.5, 60.4, 127, 200],
  clamp01: [-1, 0, 0.25, 1, 2],
  midi7: [0, 0.5, 1, 2, 64, 127, 200, -3],
  midiChannelByte: [0, 1, 2, 10, 16, 17, 99],
  midiInputChannel: [0, 1, 16, 17, -2, 3.4],
  midiOutputChannel: [0, 1, 16, 17, -2, 3.4],
  midiMessageIndex: [0, 1, 2, 3, -1, 1.4],
};

const SCALAR_FNS: Record<string, (value: number) => number> = {
  jsRound: (value) => Math.round(value),
  voltsFromMidi,
  midiFromVolts,
  clampMidi,
  clamp01,
  midi7,
  midiChannelByte,
  midiInputChannel,
  midiOutputChannel,
  midiMessageIndex,
};

function encodeProbe(entry: { type: string; a: number; b: number; channel: number }): number[] {
  if (entry.type === 'noteOn') {
    return Array.from(encodeMidiVoiceEvent({ type: 'noteOn', note: entry.a, velocity: entry.b }, entry.channel));
  }
  if (entry.type === 'noteOff') {
    return Array.from(encodeMidiVoiceEvent({ type: 'noteOff', note: entry.a }, entry.channel));
  }
  if (entry.type === 'cc') {
    return Array.from(encodeMidiVoiceEvent({ type: 'cc', cc: entry.a, value: entry.b }, entry.channel));
  }
  return Array.from(encodeMidiVoiceEvent({ type: 'program', program: entry.a }, entry.channel));
}

/**
 * FNV-1a over the fixture with its own stamp blanked.
 *
 * Fields are listed rather than spread, so the hash does not depend on the
 * order `JSON.stringify` happened to walk an object in. The same reasoning as
 * `fixtureStamp`: a stamp that reports staleness for an edit that changed
 * nothing is a stamp nobody believes the second time.
 */
export function midiFixtureStamp(
  fixture: Omit<MidiConformanceFixture, 'stamp'> & { stamp?: string },
): string {
  const body = JSON.stringify([
    fixture.version,
    fixture.inOutputs,
    fixture.outInputs,
    fixture.messageNames,
    fixture.ioKinds,
    fixture.defaults,
    fixture.trigSeconds,
    fixture.emptySample,
    fixture.outlets,
    fixture.inlets,
    fixture.parse,
    fixture.monitor,
    fixture.output,
    fixture.encode,
    fixture.scalars,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildMidiConformanceFixture(): MidiConformanceFixture {
  const outlets: MidiOutletCase[] = OUTLET_INPUTS.map((entry) => ({
    name: entry.name,
    snapshot: entry.snapshot,
    levels: midiInOutlets(entry.snapshot ?? undefined),
  }));

  const inlets: MidiInletCase[] = INLET_INPUTS.map((entry) => ({
    name: entry.name,
    cables: { ...entry.cables },
    readings: { ...entry.readings },
    sample: midiOutSample(entry.cables, (inlet) => entry.readings[inlet]),
  }));

  const parse: MidiParseCase[] = PARSE_INPUTS.map((entry) => ({
    name: entry.name,
    bytes: [...entry.bytes],
    channel: entry.channel,
    event: parseMidiBytes(Uint8Array.from(entry.bytes), entry.channel),
  }));

  const monitor: MidiMonitorCase[] = MONITOR_INPUTS.map((entry) => {
    const watcher = new MidiInputMonitor();
    const steps: MidiMonitorStep[] = entry.packets.map((bytes) => {
      const event = parseMidiBytes(Uint8Array.from(bytes), entry.channel);
      if (event) watcher.apply(event);
      return { bytes: [...bytes], snapshot: watcher.snapshot };
    });
    return { name: entry.name, channel: entry.channel, steps };
  });

  const output: MidiOutputCase[] = OUTPUT_INPUTS.map((entry) => {
    const state = createMidiOutputState();
    const ticks: MidiOutputTick[] = entry.ticks.map((tick) => {
      const events = stepMidiOutput(tick, entry.cables, entry.fields, state, entry.dtSec);
      return {
        sample: { ...tick },
        types: events.map((event) => event.type),
        bytes: events.map((event) => Array.from(encodeMidiVoiceEvent(event, entry.fields.channel))),
      };
    });
    return {
      name: entry.name,
      fields: { ...entry.fields },
      cables: { ...entry.cables },
      dtSec: entry.dtSec,
      ticks,
    };
  });

  const encode: MidiEncodeCase[] = ENCODE_INPUTS.map((entry) => ({
    ...entry,
    bytes: encodeProbe(entry),
  }));

  const scalars: MidiScalarCase[] = [];
  for (const [fn, probes] of Object.entries(SCALAR_PROBES)) {
    const impl = SCALAR_FNS[fn]!;
    for (const input of probes) scalars.push({ fn, input, output: impl(input) });
  }

  const fixture: Omit<MidiConformanceFixture, 'stamp'> = {
    note: 'Generated by scripts/emit-midi-fixtures.ts. Do not edit by hand: run `npm run fixtures:midi`.',
    version: MIDI_CONFORMANCE_FIXTURE_VERSION,
    inOutputs: [...MIDI_IN_OUTPUTS],
    outInputs: [...MIDI_OUT_INPUTS],
    messageNames: [...MIDI_MESSAGE_NAMES],
    ioKinds: { ...DEFAULT_PATCH_IO },
    defaults: { midiIn: { ...DEFAULT_MIDI_IN_FIELDS }, midiOut: { ...DEFAULT_MIDI_OUT_FIELDS } },
    trigSeconds: MIDI_TRIG_SECONDS,
    emptySample: emptyMidiSample(),
    outlets,
    inlets,
    parse,
    monitor,
    output,
    encode,
    scalars,
  };

  return { ...fixture, stamp: midiFixtureStamp(fixture) };
}
