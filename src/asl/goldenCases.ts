/**
 * The graphs the golden-audio snapshot is taken from, and the exact recipe
 * used to render them.
 *
 * Separate from the test because a second implementation has to render the
 * same things the same way. `scripts/emit-asl-fixtures.ts` serialises these
 * into a fixture the Swift interpreter is checked against, so the JS
 * snapshot and the Swift conformance suite cannot describe different graphs
 * and both claim to pass.
 */
import { ASL, type ASLGraphDescriptor } from './graph';
import { compileVoice } from './compile';
import type { ASLNode } from './types';
import { tap } from './analysis';
import { transport, type TransportSnapshot } from './transportNodes';
import {
  audio,
  bitcrush,
  clip,
  clock,
  clockDivide,
  clockMultiply,
  compare,
  compressor,
  dcBlock,
  delay,
  downsample,
  env,
  envFollow,
  euclidean,
  expander,
  filter,
  flipFlop,
  grain,
  impulse,
  kernel,
  lfo,
  logic,
  looper,
  mix,
  onset,
  pitch,
  osc,
  panLaw,
  peak,
  pitchShift,
  pulse,
  quantize,
  rectify,
  reverse,
  rms,
  sampleHold,
  samplePlay,
  select,
  sequencer,
  slew,
  transient,
  trigger,
  uniform,
  waveshape,
  wavetable,
} from './builders';

export const SR = 48000;
export const FRAMES = 512;

/**
 * Blocks rendered per case. The first is kept because it is the only one
 * that sees an attack, a one-shot or an impulse; the last because by then
 * every delay line and ring buffer has filled and wrapped at least once. A
 * fingerprint of only the last would call a dead one-shot and a working one
 * identical.
 */
export const BLOCKS = 4;

/** The params both sides set before rendering. Stated once so neither invents its own. */
export const GOLDEN_PARAMS: Readonly<Record<string, number>> = {
  note: 57,
  velocity: 0.8,
  cutoff: 1400,
  gain: 0.7,
  pan: -0.25,
};

/**
 * Tempo for the transport cases. Any number would do; this one is not a
 * multiple of the block rate, so a division boundary lands inside a block
 * rather than politely at its edge. An off-by-one in phase wrapping shows up
 * as a deviation instead of hiding at a block boundary where both
 * implementations happen to reset.
 */
export const GOLDEN_BPM = 132;

/**
 * What the host says the song is doing at the start of block `index`.
 *
 * Transport nodes are the one class of node whose value comes from outside
 * the graph, so a fixture that never supplies a snapshot renders them all
 * against `DEFAULT_TRANSPORT`: stopped, at beat zero, forever. That proves
 * the field names decode and nothing else. Advancing the position per block,
 * exactly as a renderer does, is what makes `phase`, `pulse` and `bars`
 * actually move.
 */
export function transportForBlock(index: number): TransportSnapshot {
  return {
    beats: (index * FRAMES * GOLDEN_BPM) / (SR * 60),
    bpm: GOLDEN_BPM,
    playing: true,
    beatsPerBar: 4,
    beatUnit: 4,
  };
}

/**
 * Left and right input blocks for the insert cases.
 *
 * Two partials and a slow envelope, so a filter, a follower and a transient
 * shaper all have something to bite on. The right channel is deliberately a
 * *different* signal rather than a copy: a graph that reads `audio.right()`
 * or splits its state per channel is indistinguishable from one that does not
 * when both sides are fed the same samples, which is how a stereo insert that
 * silently collapses to mono passes a conformance suite.
 */
export function goldenInput(): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(FRAMES);
  const right = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    const t = i / SR;
    const envelope = 0.2 + 0.8 * (i / FRAMES);
    left[i] =
      (Math.sin(2 * Math.PI * 220 * t) * 0.6 + Math.sin(2 * Math.PI * 1750 * t) * 0.25) * envelope;
    right[i] =
      (Math.sin(2 * Math.PI * 330 * t) * 0.45 + Math.sin(2 * Math.PI * 990 * t) * 0.3) *
      (1.0 - 0.7 * (i / FRAMES));
  }
  return { left, right };
}

/** One rendered case: the first and last block, per channel. */
export interface GoldenRender {
  first: Float32Array;
  last: Float32Array;
  /** Null when the graph is mono and the renderer would mirror channel 0. */
  firstR: Float32Array | null;
  lastR: Float32Array | null;
}

/**
 * The recipe, in one place.
 *
 * The JavaScript snapshot and the Swift conformance fixture have to render
 * the same graphs the same way, or the two can describe different things and
 * both claim to pass. That was previously two copies of this loop, one here
 * and one in `scripts/emit-asl-fixtures.ts`, which is exactly the drift this
 * file's header warns about.
 */
export function renderGoldenCase(graph: ASLGraphDescriptor, insert: boolean): GoldenRender {
  const voice = compileVoice(graph);
  const state = voice.createState();
  for (const [key, value] of Object.entries(GOLDEN_PARAMS)) state.params[key] = value;
  voice.noteOn(state, {});

  const { left, right } = goldenInput();
  const out = new Float32Array(FRAMES);
  const outR = new Float32Array(FRAMES);
  let first = new Float32Array(FRAMES);
  let firstR = new Float32Array(FRAMES);
  let wroteRight = false;

  for (let b = 0; b < BLOCKS; b++) {
    wroteRight = voice.renderBlock(state, SR, out, insert ? left : undefined, {
      inputR: insert ? right : undefined,
      outputR: outR,
      transport: transportForBlock(b),
    });
    if (b === 0) {
      first = Float32Array.from(out);
      firstR = Float32Array.from(outR);
    }
  }

  return {
    first,
    last: Float32Array.from(out),
    firstR: wroteRight ? firstR : null,
    lastR: wroteRight ? Float32Array.from(outR) : null,
  };
}

/**
 * FNV-1a over the raw sample bytes. A digest rather than the samples
 * themselves because 512 floats per case is unreadable in a diff, and
 * because the question this answers is binary: did any sample move.
 */
export function digest(block: Float32Array): string {
  const bytes = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The digest plus enough plain numbers to tell, from a failing diff alone,
 * whether the output went quiet, went loud, or moved slightly.
 */
export function fingerprint(graph: ASLGraphDescriptor, insert: boolean): string {
  const rendered = renderGoldenCase(graph, insert);
  const stereo = rendered.firstR !== null;
  const blocks = stereo
    ? [rendered.first, rendered.last, rendered.firstR!, rendered.lastR!]
    : [rendered.first, rendered.last];

  const all = new Float32Array(FRAMES * blocks.length);
  blocks.forEach((block, index) => all.set(block, index * FRAMES));

  let peakValue = 0;
  let sumSq = 0;
  for (let i = 0; i < all.length; i++) {
    const v = all[i]!;
    const abs = v < 0 ? -v : v;
    if (abs > peakValue) peakValue = abs;
    sumSq += v * v;
  }
  return [
    digest(all),
    stereo ? 'stereo' : 'mono',
    `peak=${peakValue.toFixed(9)}`,
    `rms=${Math.sqrt(sumSq / all.length).toFixed(9)}`,
    `first0=${rendered.first[0]!.toFixed(9)}`,
    `first255=${rendered.first[255]!.toFixed(9)}`,
    `last255=${rendered.last[255]!.toFixed(9)}`,
    `last511=${rendered.last[511]!.toFixed(9)}`,
  ].join(' ');
}

export const sourceCases: Record<string, ASLGraphDescriptor> = {
  'osc sine': ASL.node(({ note }) => osc({ freq: note.toFrequency() })),
  'osc saw': ASL.node(({ note }) => osc({ freq: note.toFrequency(), type: 'saw' })),
  'osc square': ASL.node(({ note }) => osc({ freq: note.toFrequency(), type: 'square' })),
  'osc triangle': ASL.node(({ note }) => osc({ freq: note.toFrequency(), type: 'triangle' })),
  'osc pulse': ASL.node(({ note }) => osc({ freq: note.toFrequency(), type: 'pulse', width: uniform(0.2) })),
  lfo: ASL.node(() => lfo({ rate: uniform(30), shape: 'triangle' })),
  range: ASL.node(() => lfo({ rate: uniform(25) }).range(-3, 9)),
  adsr: ASL.node(() => env.adsr({ a: 0.002, d: 0.01, s: 0.5, r: 0.05 }).trigger(uniform(0.8))),
  dahdsr: ASL.node(() =>
    env.dahdsr({
      delay: uniform(0.001),
      attack: uniform(0.002),
      hold: uniform(0.002),
      decay: uniform(0.01),
      sustain: uniform(0.4),
      release: uniform(0.05),
    }),
  ),
  breakpoints: ASL.node(() => env.breakpoints({ times: [0, 0.002, 0.006], levels: [0, 1, 0.3] })),
  impulse: ASL.node(() => impulse()),
  clock: ASL.node(() => clock({ freq: uniform(700) })),
  'clock divide': ASL.node(() => clockDivide(clock({ freq: uniform(900) }), { factor: uniform(3) })),
  logic: ASL.node(() => logic.xor(clock({ freq: uniform(700) }), clock({ freq: uniform(430) }))),
  'flip flop': ASL.node(() => flipFlop(clock({ freq: uniform(600) }))),
  pulse: ASL.node(() => pulse(clock({ freq: uniform(300) }), { widthSec: uniform(0.0008) })),
  euclidean: ASL.node(() => euclidean(clock({ freq: uniform(800) }), { steps: uniform(8), hits: uniform(3) })),
  sequencer: ASL.node(() =>
    sequencer(clock({ freq: uniform(500) }), [uniform(0.1), uniform(0.5), uniform(-0.3)]),
  ),
  quantize: ASL.node(() => quantize(lfo({ rate: uniform(20) }).range(48, 72), { root: uniform(2) })),
  'sample hold': ASL.node(() => sampleHold(lfo({ rate: uniform(311) }), { freq: uniform(90) })),
  wavetable: ASL.node(({ note }) =>
    wavetable({ freq: note.toFrequency(), table: [0, 0.7, 1, 0.7, 0, -0.7, -1, -0.7] }),
  ),
  'sample play': ASL.node(() =>
    samplePlay({ rate: uniform(1), box: { samples: Float32Array.from({ length: 900 }, (_, i) => Math.sin(i / 7) * 0.5), sampleRate: SR } }),
  ),
  mix: ASL.node(({ note }) =>
    mix(osc({ freq: note.toFrequency() }).mul(0.4), osc({ freq: note.toFrequency().mul(2) }).mul(0.2)),
  ),
  select: ASL.node(({ note }) =>
    select(osc({ freq: note.toFrequency() }), lfo({ rate: uniform(40) }), { which: clock({ freq: uniform(200) }) }),
  ),
  'clock multiply': ASL.node(() => clockMultiply(clock({ freq: uniform(300) }), { factor: uniform(4) })),
  // Reset, on the five nodes that carry a position in a pattern. A slow
  // clock resets a fast one, which is the shape of the real use (the
  // transport's `playing` restarting the patch on the bar) with nothing
  // stateful outside the graph. The driven clocks are deliberately not whole
  // multiples of the driver, so a node that ignores its reset and one that
  // honours it cannot produce the same samples.
  'clock reset': ASL.node(() => clock({ freq: uniform(700), reset: clock({ freq: uniform(190) }) })),
  'clock divide reset': ASL.node(() =>
    clockDivide(clock({ freq: uniform(900) }), { factor: uniform(3), reset: clock({ freq: uniform(170) }) }),
  ),
  'clock multiply reset': ASL.node(() =>
    clockMultiply(clock({ freq: uniform(300) }), { factor: uniform(4), reset: clock({ freq: uniform(130) }) }),
  ),
  'euclidean reset': ASL.node(() =>
    euclidean(clock({ freq: uniform(800) }), {
      steps: uniform(8),
      hits: uniform(3),
      reset: clock({ freq: uniform(210) }),
    }),
  ),
  'sequencer reset': ASL.node(() =>
    sequencer(clock({ freq: uniform(500) }), [uniform(0.1), uniform(0.5), uniform(-0.3)], {
      reset: clock({ freq: uniform(160) }),
    }),
  ),

  // An LFO can be restarted and offset. Both are read, not stored: `phase`
  // shifts where the shape is sampled while the cycle keeps running, which is
  // what lets two LFOs at one rate sit apart. A supersquare case as well,
  // because that shape is the one with a second phase of its own and so the
  // one an offset can get wrong.
  'lfo reset': ASL.node(() => lfo({ rate: uniform(40), reset: clock({ freq: uniform(170) }) })),
  'lfo phase': ASL.node(() => lfo({ rate: uniform(35), phase: uniform(0.25) })),
  'lfo phase supersquare': ASL.node(() =>
    lfo({ rate: uniform(30), shape: 'supersquare', width: uniform(0.4), phase: uniform(0.3) }),
  ),

  // Sample and hold on somebody else's clock, with its own rate switched off.
  // The pair matters: one case proves the external clock samples, and the
  // other that `freq` at zero really does stop the internal one, which is
  // what keeps the two grids from fighting.
  'sample hold clocked': ASL.node(() =>
    sampleHold(lfo({ rate: uniform(311) }), { freq: uniform(0), clock: clock({ freq: uniform(90) }) }),
  ),
  'sample hold both clocks': ASL.node(() =>
    sampleHold(lfo({ rate: uniform(311) }), { freq: uniform(70), clock: clock({ freq: uniform(90) }) }),
  ),

  grain: ASL.node(() =>
    grain(clock({ freq: uniform(400) }), {
      duration: uniform(0.002),
      position: uniform(0.2),
      rate: uniform(1),
      box: {
        samples: Float32Array.from({ length: 1200 }, (_, i) => Math.sin(i / 11) * 0.6),
        sampleRate: SR,
      },
    }),
  ),

  // The transport fields, one case each rather than one case reading all of
  // them, so a failure names the field that broke. Divisions are short on
  // purpose: four blocks is 10.7 ms of audio, and a musical division would
  // not wrap inside it, so a phase that never wraps and one that wraps
  // wrongly would look the same.
  'transport beats': ASL.node(() => transport.beats()),
  'transport bars': ASL.node(() => transport.bars()),
  'transport bpm': ASL.node(() => transport.bpm().mul(0.001)),
  'transport playing': ASL.node(() => transport.playing()),
  'transport phase': ASL.node(() => transport.phase(uniform(0.02))),
  'transport pulse': ASL.node(() => transport.pulse(uniform(0.01))),
  'transport seconds': ASL.node(() => transport.seconds(uniform(0.5)).mul(10)),
  // A swept index, out of range at both ends, because clamping a menu that
  // grew in a later version is the behaviour that actually matters here.
  'transport division': ASL.node(() => transport.division(lfo({ rate: uniform(90) }).range(-2, 14))),
  'transport beatsPerBar': ASL.node(() => transport.beatsPerBar().mul(0.1)),
  'transport beatUnit': ASL.node(() => transport.beatUnit().mul(0.1)),

  // Nothing is bound to these slots, and that is the case worth pinning: an
  // instrument with no engine is silent, and an effect with no
  // engine passes its input through rather than muting the track. Both are
  // contracts a second implementation has to honour, and both are invisible
  // until a kernel fails to load in front of a user.
  'kernel source unbound silence': ASL.node(() =>
    kernel.source('nothing-is-bound-here', undefined, { fallback: 'silence' }),
  ),
};

/**
 * A record gate that stays high long enough for the looper to capture a loop.
 *
 * Shared by both pulse cases so their outputs are directly comparable: the
 * point of the pair is that `start` and `end` fire at different samples, and
 * that only means something if they were driven identically.
 */
function looperRecordGate() {
  return compare(osc({ freq: uniform(200), type: 'square' }), { threshold: uniform(0) });
}

export const insertCases: Record<string, ASLGraphDescriptor> = {
  lowpass: ASL.node(({ cutoff }) => filter.lowpass(audio.input(), { cutoff })),
  highpass: ASL.node(({ cutoff }) => filter.highpass(audio.input(), { cutoff })),
  bandpass: ASL.node(({ cutoff }) => filter.bandpass(audio.input(), { cutoff, q: uniform(3) })),
  notch: ASL.node(({ cutoff }) => filter.notch(audio.input(), { cutoff, q: uniform(2) })),
  allpass: ASL.node(({ cutoff }) => filter.allpass(audio.input(), { cutoff })),
  peaking: ASL.node(() => filter.peaking(audio.input(), { freq: uniform(900), gainDb: uniform(6), q: uniform(1.2) })),
  lowshelf: ASL.node(() => filter.lowshelf(audio.input(), { freq: uniform(200), gainDb: uniform(-5) })),
  highshelf: ASL.node(() => filter.highshelf(audio.input(), { freq: uniform(4000), gainDb: uniform(4) })),
  'one pole lowpass': ASL.node(({ cutoff }) => filter.onePoleLowpass(audio.input(), { cutoff })),
  'one pole highpass': ASL.node(({ cutoff }) => filter.onePoleHighpass(audio.input(), { cutoff })),
  'svf lowpass': ASL.node(({ cutoff }) => filter.svf(audio.input(), { cutoff, q: uniform(2) })),
  'svf highpass': ASL.node(({ cutoff }) => filter.svf(audio.input(), { cutoff, q: uniform(2), mode: 'highpass' })),
  'svf bandpass': ASL.node(({ cutoff }) => filter.svf(audio.input(), { cutoff, q: uniform(2), mode: 'bandpass' })),
  ladder: ASL.node(({ cutoff }) => filter.ladder(audio.input(), { cutoff, resonance: uniform(0.6) })),
  // Drive saturates into the filter. The pair is the assertion: at 1 it must
  // be the plain ladder to the bit, and above it must not be.
  'ladder drive unity': ASL.node(() =>
    filter.ladder(audio.input(), { cutoff: uniform(900), resonance: uniform(0.4), drive: uniform(1) }),
  ),
  'ladder drive': ASL.node(() =>
    filter.ladder(audio.input(), { cutoff: uniform(900), resonance: uniform(0.4), drive: uniform(5) }),
  ),
  comb: ASL.node(() => filter.comb(audio.input(), { freq: uniform(180) })),
  'slope 4 pole': ASL.node(({ cutoff }) => filter.slope(audio.input(), { cutoff, poles: 4 })),
  'slope highpass': ASL.node(({ cutoff }) => filter.slope(audio.input(), { cutoff, poles: 3, mode: 'highpass' })),
  'clip soft': ASL.node(() => clip(audio.input(), { drive: uniform(4) })),
  'clip hard': ASL.node(() => clip(audio.input(), { drive: uniform(4), mode: 'hard' })),
  waveshape: ASL.node(() => waveshape(audio.input(), { curve: [-1, -0.5, 0, 0.8, 1] })),
  bitcrush: ASL.node(() => bitcrush(audio.input(), { bits: uniform(5) })),
  downsample: ASL.node(() => downsample(audio.input(), { factor: uniform(6) })),
  'rectify full': ASL.node(() => rectify(audio.input())),
  'rectify half': ASL.node(() => rectify(audio.input(), { mode: 'half' })),
  'dc block': ASL.node(() => dcBlock(audio.input())),
  delay: ASL.node(() => delay(audio.input(), { timeSec: uniform(0.003), feedback: uniform(0.4), mix: uniform(0.5), maxTimeSec: 0.05 })),
  reverse: ASL.node(() => reverse(audio.input(), { timeSec: uniform(0.004), maxTimeSec: 0.05 })),
  looper: ASL.node(() => looper(audio.input(), { record: clock({ freq: uniform(60) }), maxTimeSec: 0.05 })),
  // The two pulse outlets. A looper that returns the right audio and the wrong
  // edges is a looper whose wrap fires nothing, and until these existed the
  // fixture covered the kind while leaving two of its three fields to whatever
  // each implementation happened to do.
  //
  // The record gate is a sustained square, not the one-sample `clock` the
  // audio case uses, and that is the whole difficulty of writing these. A
  // clock pulse opens and closes a take on consecutive samples, so `playLen`
  // comes out as 1, and then `playRead === 0` and `playRead === playLen - 1`
  // are both true on every sample: `start` and `end` are constant 1 and
  // identical to each other. That renders audibly, passes the silence check,
  // and asserts nothing at all. A gate that stays high long enough to record a
  // real loop makes the two fire at different samples, which is the only
  // arrangement in which swapping them fails.
  'looper start pulse': ASL.node(() =>
    looper(audio.input(), { record: looperRecordGate(), maxTimeSec: 0.01, field: 'start' }),
  ),
  'looper end pulse': ASL.node(() =>
    looper(audio.input(), { record: looperRecordGate(), maxTimeSec: 0.01, field: 'end' }),
  ),
  'pitch shift': ASL.node(() => pitchShift(audio.input(), { pitch: uniform(1.5) })),
  compressor: ASL.node(() =>
    compressor(audio.input(), { threshold: uniform(0.2), ratio: uniform(6), attack: uniform(0.002), release: uniform(0.08) }),
  ),
  'compressor sidechain': ASL.node(() =>
    compressor(audio.input(), {
      threshold: uniform(0.2),
      ratio: uniform(6),
      attack: uniform(0.002),
      release: uniform(0.08),
      sidechain: audio.left(),
    }),
  ),
  expander: ASL.node(() =>
    expander(audio.input(), { threshold: uniform(0.5), ratio: uniform(3), attack: uniform(0.002), release: uniform(0.06) }),
  ),
  transient: ASL.node(() => transient(audio.input(), { attack: uniform(0.6), sustain: uniform(-0.3) })),
  'env follow': ASL.node(() => envFollow(audio.input(), { attack: uniform(0.002), release: uniform(0.05) })),
  rms: ASL.node(() => rms(audio.input(), { windowSec: uniform(0.004) })),
  peak: ASL.node(() => peak(audio.input(), { release: uniform(0.05) })),
  slew: ASL.node(() => slew(audio.input(), { rise: uniform(40), fall: uniform(15) })),
  trigger: ASL.node(() => trigger(audio.input(), { threshold: uniform(0.3) })),
  compare: ASL.node(() => compare(audio.input(), { threshold: uniform(0.1), mode: 'lt' })),
  'pan law left': ASL.node(({ pan }) => panLaw(audio.input(), { pan, channel: 'left' })),
  'pan law right': ASL.node(({ pan }) => panLaw(audio.input(), { pan, channel: 'right' })),
  'lane split': ASL.node(() => audio.left().mul(0.7).add(audio.right().mul(0.3))),
  // The threshold is compared against a *per-sample* change in a 5 ms
  // envelope, not against a level, so it is three orders of magnitude smaller
  // than a level threshold would be. Anything larger renders silence, and a
  // silent case is coverage that asserts nothing.
  onset: ASL.node(() => onset(audio.input(), { threshold: uniform(0.001) })),
  pitch: ASL.node(() => pitch(osc({ freq: uniform(440) }), { field: 'midi' }).mul(0.01)),
  // One case per pitch field, for the same reason transport gets one per
  // field: they share a detector and nothing else, so proving `midi` decodes
  // proves nothing about `cents` or `gate`. Scaled where the raw units would
  // otherwise dwarf the tolerance.
  'pitch hz': ASL.node(() => pitch(osc({ freq: uniform(440) }), { field: 'hz' }).mul(0.001)),
  'pitch cents': ASL.node(() => pitch(osc({ freq: uniform(437) }), { field: 'cents' }).mul(0.01)),
  'pitch gate': ASL.node(() => pitch(osc({ freq: uniform(440) }), { field: 'gate' })),

  // Which channel am I on, as a number. Only meaningful now that the fixture
  // records both output channels: with the right channel discarded, every
  // implementation agrees that the left one is zero.
  lane: ASL.node(() => audio.input().mul(audio.lane().mul(0.6).add(0.4))),

  // Taps must be exactly transparent, and must record once per sample rather
  // than once per pass. The audible failure is not a wrong meter reading, it
  // is a seam graph whose whole signal is doubled, so the assertion that
  // matters is on the audio.
  'tap meter': ASL.node(() => tap.meter(audio.input(), { id: 'golden' }).mul(0.5)),
  'tap capture': ASL.node(() => tap.capture(audio.input(), { id: 'golden', windowSize: 64 }).mul(0.5)),

  // An unbound seam degrades to a plain wire; an unbound source effect passes
  // its input through. See the silence case in `sourceCases` for the other
  // half of the fallback contract.
  'kernel seam unbound': ASL.node(() => kernel.seam('nothing-is-bound-here', audio.input()).mul(0.8)),
  'kernel source unbound passthrough': ASL.node(() =>
    kernel.source('nothing-is-bound-here', audio.input()),
  ),
};

/** Every case, source and insert, with the flag that says how to render it. */
export function allGoldenCases(): { name: string; insert: boolean; graph: ASLGraphDescriptor }[] {
  return [
    ...Object.entries(sourceCases).map(([name, graph]) => ({ name, insert: false, graph })),
    ...Object.entries(insertCases).map(([name, graph]) => ({ name, insert: true, graph })),
  ];
}

/**
 * Node kinds that have no golden case, and why.
 *
 * Both entries call `Math.random()`, so two runs of the *same* implementation
 * do not agree with each other, let alone two implementations. There is
 * nothing for a sample comparison to assert.
 *
 * A graph containing `noise` or `random` cannot be reproduced, bounced twice
 * to the same file, or compared against a native render. Seeding the
 * generator from voice state would bring them inside the snapshot, and would
 * change what those nodes sound like.
 */
export const COVERAGE_EXEMPT_KINDS: Readonly<Record<string, string>> = {
  noise: 'Math.random per sample: not reproducible within one implementation, let alone across two',
  random: 'Math.random per step: same reason as noise',
};

/** Every node kind reachable from a golden case. */
export function coveredKinds(): Set<string> {
  const seen = new Set<string>();
  const walk = (node: ASLNode): void => {
    seen.add(node.kind);
    for (const child of Object.values(node.inputs)) walk(child);
    if (node.list) for (const child of node.list) walk(child);
  };
  for (const { graph } of allGoldenCases()) walk(graph.output);
  return seen;
}

/** Every `transport` field a golden case reads. */
/**
 * Every `field` value a kind is rendered with, across all golden cases.
 *
 * A kind with a `field` param is really several nodes sharing a name, and the
 * coverage gate counting the kind once was reading a single `looper` case as
 * evidence for its `start` and `end` outlets too. `defaultField` is what an
 * absent param means, so a case written without one still counts.
 */
export function coveredNodeFields(kind: string, defaultField: string): Set<string> {
  const seen = new Set<string>();
  const walk = (node: ASLNode): void => {
    if (node.kind === kind) seen.add(String(node.params.field ?? defaultField));
    for (const child of Object.values(node.inputs)) walk(child);
    for (const child of node.list ?? []) walk(child);
  };
  for (const { graph } of allGoldenCases()) walk(graph.output);
  return seen;
}

export function coveredTransportFields(): Set<string> {
  const seen = new Set<string>();
  const walk = (node: ASLNode): void => {
    if (node.kind === 'transport') seen.add(String(node.params.field ?? 'beats'));
    for (const child of Object.values(node.inputs)) walk(child);
    if (node.list) for (const child of node.list) walk(child);
  };
  for (const { graph } of allGoldenCases()) walk(graph.output);
  return seen;
}
