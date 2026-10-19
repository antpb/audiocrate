/**
 * The motion conformance fixture: every palette material, rendered while its
 * parameters move and its note is released and struck again.
 *
 * The ASL fixture holds the interpreters together with every parameter fixed,
 * which is the right way to compare two implementations and is blind to a
 * whole class of difference: anything that happens *because a value changed*.
 * Block-rate evaluation caches a parameter subtree per block and has to notice
 * the block it goes stale; a delay glides its read pointer toward a new time;
 * a filter recomputes coefficients when its cutoff key moves; an envelope
 * releases and retriggers. None of that runs in a render where nothing moves.
 *
 * It is also the first place the palette itself is compared as sound. The
 * Swift side has compiled every palette material since the catalog existed,
 * and rendered none of them against JavaScript.
 *
 * Graphs are not duplicated here: each case names a kind, and the reader takes
 * that kind's graph from `material-catalog.json`, the file the native palette
 * ships. What this fixture adds is the schedule and what JavaScript rendered.
 *
 * The schedule is stored as explicit values rather than as a rule, so a reader
 * replays numbers and never re-derives a log-curve parameter in its own libm.
 */
import { compileVoice } from '../../src/asl/compile';
import type { TransportSnapshot } from '../../src/asl/transportNodes';
import { denormalizeParam } from '../../src/graph/param';
import { buildMaterialCatalog, type CatalogMaterialEntry } from './materialCatalog';

/**
 * Bumped when the shape changes, not when a material does.
 *
 * 1: kind-keyed cases, explicit events, float32-exact left and right.
 *    Parameter events go through `setParam`, so they glide where the
 *    catalog graph's `smooth` says.
 */
export const MOTION_FIXTURE_VERSION = 1;

export const MOTION_SAMPLE_RATE = 48000;
export const MOTION_FRAMES = 128;
export const MOTION_BLOCKS = 12;
export const MOTION_BPM = 132;

/** Something that happens before a block renders. */
export interface MotionEvent {
  block: number;
  /** Parameter values written before the block. */
  params?: Record<string, number>;
  /** `on` writes `noteParams` and opens the gate; `off` closes it. */
  note?: 'on' | 'off';
  noteParams?: Record<string, number>;
}

export interface MotionCase {
  kind: string;
  insert: boolean;
  events: MotionEvent[];
  /** Every sample of every block, as float32 values. */
  left: number[];
  /** Absent when the graph is mono and the right channel is a mirror. */
  right?: number[];
}

export interface MotionFixture {
  note: string;
  version: number;
  sampleRate: number;
  frames: number;
  blocks: number;
  bpm: number;
  /** One input per block, concatenated, both channels. */
  inputL: number[];
  inputR: number[];
  cases: MotionCase[];
  /** Kinds left out because they render silence here, which would assert nothing. */
  silent: string[];
  stamp: string;
}

/** Where each event puts each parameter, as a fraction of its travel. */
const TRAVEL = [0.15, 0.85, 0.4, 0.65];
const PARAM_BLOCKS = [2, 4, 7, 10];
const NOTE_OFF_BLOCK = 6;
const NOTE_ON_BLOCK = 8;
const FIRST_NOTE = { note: 57, velocity: 0.8 };
const SECOND_NOTE = { note: 64, velocity: 0.6 };

/** A number as the float32 it will be compared as, written so it round-trips. */
function f32(value: number): number {
  return Number(Math.fround(value).toPrecision(9));
}

function transportForBlock(block: number): TransportSnapshot {
  return {
    beats: (block * MOTION_FRAMES * MOTION_BPM) / (MOTION_SAMPLE_RATE * 60),
    bpm: MOTION_BPM,
    playing: true,
    beatsPerBar: 4,
    beatUnit: 4,
  };
}

/** Two partials each side, different sides, so a stereo insert cannot pass as mono. */
export function motionInput(): { left: Float32Array; right: Float32Array } {
  const n = MOTION_FRAMES * MOTION_BLOCKS;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / MOTION_SAMPLE_RATE;
    left[i] = Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 1750 * t) * 0.2;
    right[i] = Math.sin(2 * Math.PI * 330 * t) * 0.4 + Math.sin(2 * Math.PI * 990 * t) * 0.25;
  }
  return { left, right };
}

function eventsFor(material: CatalogMaterialEntry): MotionEvent[] {
  const events: MotionEvent[] = [];
  PARAM_BLOCKS.forEach((block, k) => {
    const params: Record<string, number> = {};
    material.paramOrder.forEach((name, j) => {
      // Offset per parameter so they do not all move in lockstep, which
      // would let two parameters that were swapped go unnoticed.
      const unit = (TRAVEL[k]! + 0.37 * j) % 1;
      params[name] = denormalizeParam(material.params[name]!, unit);
    });
    events.push({ block, params });
  });
  events.push({ block: NOTE_OFF_BLOCK, note: 'off' });
  events.push({ block: NOTE_ON_BLOCK, note: 'on', noteParams: { ...SECOND_NOTE } });
  return events.sort((a, b) => a.block - b.block);
}

function render(material: CatalogMaterialEntry, events: MotionEvent[]): Pick<MotionCase, 'left' | 'right'> {
  const voice = compileVoice(material.graph as never);
  const state = voice.createState();
  for (const name of material.paramOrder) state.params[name] = material.params[name]!.default;
  voice.noteOn(state, { ...FIRST_NOTE });

  const insert = material.audioInputs.includes('input');
  const { left: inL, right: inR } = motionInput();
  const out = new Float32Array(MOTION_FRAMES);
  const outR = new Float32Array(MOTION_FRAMES);
  const left: number[] = [];
  const right: number[] = [];
  let stereo = false;
  for (let block = 0; block < MOTION_BLOCKS; block++) {
    for (const event of events) {
      if (event.block !== block) continue;
      // Through `setParam`, as a host does, so continuous parameters glide
      // and the reader is held to the same glide.
      if (event.params) for (const [name, value] of Object.entries(event.params)) voice.setParam(state, name, value);
      if (event.note === 'off') voice.noteOff(state);
      if (event.note === 'on') voice.noteOn(state, event.noteParams ?? {});
    }
    const from = block * MOTION_FRAMES;
    stereo = voice.renderBlock(
      state,
      MOTION_SAMPLE_RATE,
      out,
      insert ? inL.subarray(from, from + MOTION_FRAMES) : undefined,
      {
        inputR: insert ? inR.subarray(from, from + MOTION_FRAMES) : undefined,
        outputR: outR,
        transport: transportForBlock(block),
      },
    );
    for (let i = 0; i < MOTION_FRAMES; i++) {
      // JSON writes NaN and Infinity as null, so a non-finite sample would
      // reach the reader as a decoding error about a null rather than as the
      // bug it is. Say which material and when, here, instead.
      if (!Number.isFinite(out[i]!) || !Number.isFinite(outR[i]!)) {
        throw new Error(`${material.kind} rendered a non-finite sample in block ${block}`);
      }
      left.push(f32(out[i]!));
      right.push(f32(outR[i]!));
    }
  }
  return stereo ? { left, right } : { left };
}

export function motionFixtureStamp(fixture: Omit<MotionFixture, 'stamp'> & { stamp?: string }): string {
  const body = JSON.stringify([
    fixture.version,
    fixture.sampleRate,
    fixture.frames,
    fixture.blocks,
    fixture.bpm,
    fixture.inputL,
    fixture.inputR,
    fixture.cases,
    fixture.silent,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildMotionFixture(): MotionFixture {
  const cases: MotionCase[] = [];
  const silent: string[] = [];
  for (const material of buildMaterialCatalog().materials) {
    const events = eventsFor(material);
    const rendered = render(material, events);
    const peak = rendered.left.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    if (peak < 1e-6) {
      silent.push(material.kind);
      continue;
    }
    cases.push({ kind: material.kind, insert: material.audioInputs.includes('input'), events, ...rendered });
  }
  const { left, right } = motionInput();
  const fixture: Omit<MotionFixture, 'stamp'> = {
    note: 'Generated by editor/scripts/emit-motion-fixtures.ts. Do not edit by hand: run `npm run fixtures:motion`.',
    version: MOTION_FIXTURE_VERSION,
    sampleRate: MOTION_SAMPLE_RATE,
    frames: MOTION_FRAMES,
    blocks: MOTION_BLOCKS,
    bpm: MOTION_BPM,
    inputL: Array.from(left, f32),
    inputR: Array.from(right, f32),
    cases,
    silent: silent.sort(),
  };
  return { ...fixture, stamp: motionFixtureStamp(fixture) };
}
