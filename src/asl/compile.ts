/**
 * Compiles an ASL graph into a single JS closure, evaluated once per sample
 * per voice. One fused unit instead of a node-per-primitive graph. The
 * public builder API (builders.ts, graph.ts) does not depend on this being
 * JS rather than WASM.
 */
import type { ASLGraphDescriptor } from './graph';
import type {
  ASLNode,
  ClipMode,
  CompareMode,
  LogicMode,
  NoiseColor,
  OscShape,
  PanLawChannel,
  LooperBox,
  SampleBox,
  SlopeMode,
  RandomMode,
  RectifyMode,
  SvfMode,
} from './types';
import { euclideanPattern, quantizeToScale } from './controlMath';
import {
  DEFAULT_TRANSPORT,
  barBeats,
  normalizeBeatUnit,
  signatureBeatBeats,
  type TransportSnapshot,
} from './transportNodes';
import { audioPortNames } from './ports';
import { MAIN_PORT } from './builders';
import type { AnalysisFrame, CaptureBuffer, MeterAccumulator, MeterReading } from './analysis';
import type { KernelBindings } from '../renderers/kernel';

interface OscMemory {
  phase: number;
  slavePhase: number;
}

type EnvStage = 'idle' | 'delay' | 'attack' | 'hold' | 'decay' | 'sustain' | 'release';

interface AdsrMemory {
  stage: EnvStage;
  level: number;
  peak: number;
  stageElapsed: number;
  stageStartLevel: number;
  lastGate: boolean;
}

/**
 * A biquad's delay line, plus the coefficients it is currently running and
 * the inputs those were derived from.
 *
 * Cutoff and Q are graph inputs, so they *can* change every sample and a
 * filter has to be ready for that. In practice they almost never do: a
 * fixed EQ band, a knob nobody is touching, an envelope that has reached
 * sustain. Recomputing a sine, a cosine and up to a power for each of those
 * samples is the single most expensive thing an idle filter does.
 *
 * The keys start as NaN, which compares unequal to everything including
 * itself, so the first sample always computes. When the inputs match, the
 * cached coefficients are by construction the exact same doubles the
 * recomputation would have produced, so a cached filter and a recomputing
 * one are bit-identical, not merely close.
 */
interface BiquadMemory {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  /** The inputs the coefficients were computed from, sample rate included. */
  k0: number;
  k1: number;
  k2: number;
  k3: number;
  /** Coefficients, already divided through by a0. */
  n0: number;
  n1: number;
  n2: number;
  d1: number;
  d2: number;
}

function newBiquad(): BiquadMemory {
  return {
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
    k0: NaN,
    k1: NaN,
    k2: NaN,
    k3: NaN,
    n0: 0,
    n1: 0,
    n2: 0,
    d1: 0,
    d2: 0,
  };
}

const EMPTY_TABLE = new Float32Array(0);
const EMPTY_NUMBERS: readonly number[] = [];

type SeamEvalPhase = 'sample' | 'collect' | 'apply';

interface SeamNodeBuffers {
  in: Float32Array;
  out: Float32Array;
}

interface SeamBlockRuntime {
  phase: SeamEvalPhase;
  index: number;
  /** Indexed by plan slot, so a seam reads its block without a lookup. */
  buffers: (SeamNodeBuffers | undefined)[];
}

/**
 * One graph node, prepared for evaluation.
 *
 * The graph a host hands over is authoring data: node ids come from a
 * module-wide counter, so a graph built late in a session has ids in the
 * thousands and nothing in it is dense. Evaluating that directly means a
 * hash lookup per node per sample, which at 48 kHz is the interpreter's
 * single largest cost.
 *
 * So compiling walks the graph once and gives every distinct node a slot
 * from 0. Shared subgraphs get one slot between them, which is what keeps
 * the value cache doing its job. Everything a node needs per sample that
 * can be known earlier is resolved here rather than re-read out of a
 * `params` dictionary 48,000 times a second: modes become small integers,
 * tables become typed arrays, kernel slots become strings on the node.
 *
 * The field names deliberately mirror `ASLNode` (`kind`, `params`,
 * `inputs`, `list`) so the evaluator reads the same as the graph it came
 * from. The one that differs is `i`, the slot, in place of `id`.
 */
interface PlanNode {
  /** Dense slot in the value cache and the per-node memory array. */
  readonly i: number;
  readonly kind: ASLNode['kind'];
  readonly params: Record<string, unknown>;
  /** Compiled children, by the same input names the graph used. */
  readonly inputs: Record<string, PlanNode | undefined>;
  readonly list: readonly PlanNode[] | null;
  /**
   * A mode, shape, colour or field name resolved to a small integer, so the
   * hot path compares numbers instead of re-reading a dictionary and
   * comparing strings. What the number means is per kind; see `planMode`.
   */
  readonly m: number;
  /** A numeric constant off `params` (window size, max delay, pole count). */
  readonly c: number;
  /** A wavetable or sample, resolved once. Never rebuilt per sample. */
  readonly table: Float32Array;
  /** A curve, breakpoint time list, or division table, resolved once. */
  readonly a: readonly number[];
  /** The second half of a pair (`breakpoints` levels). */
  readonly b: readonly number[];
  /** A kernel slot, tap id, port or param name. Empty for kinds with none. */
  readonly name: string;
  readonly slot: string;
  /** `range` bounds, read off params once instead of destructured per sample. */
  readonly rangeMin: number;
  readonly rangeMax: number;
  /**
   * 1 when this node's value cannot change within a block, so it is computed
   * once per block instead of once per sample per channel. See
   * `BLOCK_CONSTANT_KINDS`.
   */
  readonly hoist: number;
}

/**
 * Kinds whose output is a pure function of their inputs.
 *
 * No stored state, no clock, no channel, no live audio, no randomness, and
 * nothing read from outside the graph. A node of one of these kinds whose
 * inputs are all themselves block constant is block constant, and a subtree
 * of them rooted in parameters is a coefficient calculation: the same answer
 * for every sample in the block.
 *
 * Everything absent from this set is absent on purpose. A filter, an
 * oscillator and a sample-and-hold advance state per sample and would freeze
 * if they were hoisted. `lane` is constant within one channel pass and
 * different in the next. A tap records what went by and has to see every
 * sample. `transport` is a function of where the song is, which moves inside
 * a block.
 *
 * `bitcrush` is in the set and keeps a small cache; that cache is an
 * optimisation of a pure function, not state the output depends on.
 */
const BLOCK_CONSTANT_KINDS: ReadonlySet<ASLNode['kind']> = new Set([
  'const',
  'param',
  'mul',
  'add',
  'mix',
  'range',
  'toFrequency',
  'select',
  'compare',
  'logic',
  'clip',
  'rectify',
  'waveshape',
  'quantize',
  'panLaw',
  'bitcrush',
]);

/**
 * Every input name any builder wires, on every plan node, whether that kind
 * uses it or not.
 *
 * This looks wasteful and is the opposite. `node.inputs.cutoff` is read once
 * per sample per filter; if the `inputs` objects have a different shape per
 * node kind, that one line in the evaluator sees dozens of shapes and the
 * engine gives up on caching it, which costs more than every filter
 * coefficient in the graph. One shape for all of them makes it a fixed
 * offset. The cost is a few hundred bytes per node, paid once at compile.
 *
 * A graph carrying an input name not listed here still works; that node just
 * gets its own shape. Add the name here and it rejoins the fast path.
 */
function emptyInputs(): Record<string, PlanNode | undefined> {
  return {
    input: undefined,
    a: undefined,
    b: undefined,
    attack: undefined,
    bits: undefined,
    clock: undefined,
    cutoff: undefined,
    decay: undefined,
    delay: undefined,
    drive: undefined,
    duration: undefined,
    factor: undefined,
    fall: undefined,
    feedback: undefined,
    freq: undefined,
    gainDb: undefined,
    gate: undefined,
    hits: undefined,
    hold: undefined,
    index: undefined,
    length: undefined,
    mix: undefined,
    note: undefined,
    pan: undefined,
    pitch: undefined,
    position: undefined,
    q: undefined,
    rate: undefined,
    ratio: undefined,
    record: undefined,
    release: undefined,
    resonance: undefined,
    rise: undefined,
    root: undefined,
    rotation: undefined,
    scale: undefined,
    sidechain: undefined,
    source: undefined,
    steps: undefined,
    sustain: undefined,
    threshold: undefined,
    timeSec: undefined,
    trigger: undefined,
    which: undefined,
    width: undefined,
    widthSec: undefined,
    windowSec: undefined,
    type: undefined,
    color: undefined,
  };
}

/** Oscillator and LFO shapes. */
const SHAPE_SINE = 0;
const SHAPE_SAW = 1;
const SHAPE_SQUARE = 2;
const SHAPE_TRIANGLE = 3;
const SHAPE_PULSE = 4;
const SHAPE_VARSHAPE = 5;
const SHAPE_SUPERSQUARE = 6;
const SHAPE_HARMONIC = 7;

/**
 * `params` values that the evaluator used to re-read and re-compare every
 * sample, mapped to integers. Anything unrecognised takes the same default
 * the string comparison chain fell through to.
 */
function planMode(node: ASLNode): number {
  const p = node.params;
  switch (node.kind) {
    case 'osc':
    case 'lfo': {
      const shape = (node.kind === 'osc' ? p.type : p.shape) as OscShape | undefined;
      if (shape === 'saw') return SHAPE_SAW;
      if (shape === 'square') return SHAPE_SQUARE;
      if (shape === 'triangle') return SHAPE_TRIANGLE;
      if (shape === 'pulse') return SHAPE_PULSE;
      if (shape === 'varshape') return SHAPE_VARSHAPE;
      if (shape === 'supersquare') return SHAPE_SUPERSQUARE;
      if (shape === 'harmonic') return SHAPE_HARMONIC;
      return SHAPE_SINE;
    }
    case 'clip':
      return (p.mode as ClipMode) === 'hard' ? 1 : 0;
    case 'rectify':
      return (p.mode as RectifyMode) === 'half' ? 1 : 0;
    case 'compare':
      return (p.mode as CompareMode) === 'lt' ? 1 : 0;
    case 'svf': {
      const mode = (p.mode as SvfMode) ?? 'lowpass';
      return mode === 'highpass' ? 1 : mode === 'bandpass' ? 2 : 0;
    }
    case 'logic': {
      const mode = (p.mode as LogicMode) ?? 'and';
      return mode === 'or' ? 1 : mode === 'xor' ? 2 : mode === 'not' ? 3 : 0;
    }
    case 'filterSlope':
      return ((p.mode as SlopeMode) ?? 'lowpass') === 'highpass' ? 1 : 0;
    case 'noise': {
      const color = (p.color as NoiseColor) ?? 'white';
      if (color === 'pink') return 1;
      if (color === 'brown') return 2;
      if (color === 'blue') return 3;
      if (color === 'violet') return 4;
      if (color === 'grey') return 5;
      return 0;
    }
    case 'panLaw':
      return ((p.channel as PanLawChannel) ?? 'left') === 'right' ? 1 : 0;
    case 'random':
      return (p.mode as RandomMode) === 'smooth' ? 1 : 0;
    case 'transport': {
      const field = p.field as string;
      if (field === 'bars') return 1;
      if (field === 'bpm') return 2;
      if (field === 'playing') return 3;
      if (field === 'phase') return 4;
      if (field === 'pulse') return 5;
      if (field === 'seconds') return 6;
      if (field === 'division') return 7;
      if (field === 'beatsPerBar') return 8;
      if (field === 'beatUnit') return 9;
      return 0; // beats
    }
    case 'kernel':
      // 1 source, 2 source that goes silent when nothing is bound, 0 seam.
      if (p.mode !== 'source') return 0;
      return p.fallback === 'silence' ? 2 : 1;
    case 'port':
      // A fixed channel, or -1 to follow the channel being rendered.
      return (p.channel as number | undefined) ?? -1;
    case 'pitchShift':
      return p.unit === 'st' ? 1 : 0;
    case 'pitch': {
      const field = p.field as string;
      if (field === 'midi') return 1;
      if (field === 'cents') return 2;
      if (field === 'gate') return 3;
      return 0;
    }
    case 'looper': {
      const field = p.field as string;
      if (field === 'start') return 1;
      if (field === 'end') return 2;
      return 0;
    }
    default:
      return 0;
  }
}

function planConst(node: ASLNode): number {
  const p = node.params;
  switch (node.kind) {
    case 'capture':
      return p.windowSize as number;
    case 'delay':
      return p.maxTimeSec as number;
    case 'reverse':
      return (p.maxTimeSec as number) ?? 2;
    case 'looper':
      return (p.maxTimeSec as number) ?? 4;
    case 'filterSlope':
      return Math.min(4, Math.max(1, Math.round((p.poles as number) ?? 2)));
    case 'const':
      return p.value as number;
    case 'wavetable':
      return (p.frameSize as number) ?? 0;
    default:
      return 0;
  }
}

/** A sample or wavetable, resolved once instead of on every sample. */
function planTable(node: ASLNode): Float32Array {
  if (node.kind !== 'wavetable' && node.kind !== 'samplePlay' && node.kind !== 'grain') {
    return EMPTY_TABLE;
  }
  const box = node.params.box as SampleBox | undefined;
  if (box?.samples?.length) return box.samples;
  const table = node.params.table;
  if (table instanceof Float32Array) return table;
  if (Array.isArray(table) && table.length > 0) return Float32Array.from(table);
  return EMPTY_TABLE;
}

function planNames(node: ASLNode): { name: string; slot: string } {
  const p = node.params;
  if (node.kind === 'kernel') return { name: '', slot: p.slot as string };
  if (node.kind === 'meter' || node.kind === 'capture') return { name: p.id as string, slot: '' };
  if (node.kind === 'param' || node.kind === 'port') return { name: p.name as string, slot: '' };
  return { name: '', slot: '' };
}

interface Plan {
  readonly root: PlanNode;
  /** How many slots a state has to allocate. */
  readonly count: number;
  /** Seam-kernel nodes, in discovery order, each appearing once. */
  readonly seams: readonly PlanNode[];
  /** Tap ids this graph records under. */
  readonly tapIds: readonly string[];
  /** Whether any node asks which channel it is on. */
  readonly usesLane: boolean;
  /** Whether any `param` node reads the main input as a scalar. */
  readonly readsScalarInput: boolean;
  /**
   * Whether anything in the graph draws a random number, which is what
   * stops two channels fed the same samples from producing the same output.
   */
  readonly usesRandom: boolean;
  /** How many nodes are evaluated once per block rather than once per sample. */
  readonly blockConstantNodes: number;
}

/**
 * One pass over the graph that does every walk compiling used to do
 * separately: slot assignment, seam discovery, tap ids, and the two
 * questions (`lane`, scalar `input`) that decide how a block is rendered.
 */
function buildPlan(root: ASLNode): Plan {
  const bySourceId = new Map<number, PlanNode>();
  const seams: PlanNode[] = [];
  const tapIds = new Set<string>();
  let count = 0;
  let usesLane = false;
  let readsScalarInput = false;
  let usesRandom = false;
  let blockConstantNodes = 0;

  function visit(node: ASLNode): PlanNode {
    const existing = bySourceId.get(node.id);
    if (existing) return existing;

    const { name, slot } = planNames(node);
    const inputs = emptyInputs();
    const plan: PlanNode = {
      i: count++,
      kind: node.kind,
      params: node.params,
      inputs,
      list: null,
      m: planMode(node),
      c: planConst(node),
      table: planTable(node),
      a:
        node.kind === 'waveshape'
          ? ((node.params.curve as number[] | undefined) ?? [-1, 0, 1])
          : node.kind === 'breakpoints'
            ? ((node.params.times as number[]) ?? [0, 1])
            : node.kind === 'transport'
              ? ((node.params.divisions as number[]) ?? EMPTY_NUMBERS)
              : EMPTY_NUMBERS,
      b: node.kind === 'breakpoints' ? ((node.params.levels as number[]) ?? [0, 1]) : EMPTY_NUMBERS,
      name,
      slot,
      rangeMin: node.kind === 'range' ? (node.params.min as number) : 0,
      rangeMax: node.kind === 'range' ? (node.params.max as number) : 0,
      hoist: 0,
    };
    // Registered before the children are visited, so a graph that somehow
    // refers back to itself terminates instead of recursing forever.
    bySourceId.set(node.id, plan);

    if (node.kind === 'lane') usesLane = true;
    if (node.kind === 'port' && node.params.channel !== undefined) usesLane = true;
    if (node.kind === 'param' && name === MAIN_PORT) readsScalarInput = true;
    if (node.kind === 'meter' || node.kind === 'capture') tapIds.add(name);
    if (node.kind === 'kernel' && node.params.mode === 'seam') seams.push(plan);
    if (node.kind === 'noise' || node.kind === 'random') usesRandom = true;

    for (const key of Object.keys(node.inputs)) inputs[key] = visit(node.inputs[key]!);
    const list = node.list;
    if (list) {
      const planned: PlanNode[] = [];
      for (const child of list) planned.push(visit(child));
      (plan as { list: readonly PlanNode[] | null }).list = planned;
    }
    // After the children, because a node is block constant only if all of
    // them are. The scalar `input` param is the exception among params:
    // `renderBlock` rewrites it per sample, so a subtree reading it is not
    // constant for the block even though every other param is.
    if (BLOCK_CONSTANT_KINDS.has(node.kind) && !(node.kind === 'param' && name === MAIN_PORT)) {
      let constant = true;
      for (const key of Object.keys(node.inputs)) {
        if (inputs[key]!.hoist === 0) {
          constant = false;
          break;
        }
      }
      if (constant && plan.list) {
        for (const child of plan.list) {
          if (child.hoist === 0) {
            constant = false;
            break;
          }
        }
      }
      if (constant) {
        (plan as { hoist: number }).hoist = 1;
        blockConstantNodes += 1;
      }
    }
    return plan;
  }

  const planned = visit(root);
  return {
    root: planned,
    count,
    seams,
    tapIds: [...tapIds].sort(),
    usesLane,
    readsScalarInput,
    usesRandom,
    blockConstantNodes,
  };
}

/**
 * Named live audio inputs for one block, channel-major. See `asl/ports.ts`.
 *
 * A name may be present with nothing behind it. The renderer reuses one
 * object across blocks so that describing a block's inputs allocates
 * nothing, which means an unwired port is a key holding `undefined` rather
 * than an absent key. Both read as silence.
 */
export type PortBlocks = Readonly<
  Record<string, readonly (Float32Array | undefined)[] | undefined>
>;

export interface VoiceRuntimeState {
  /**
   * Per-node output cache, indexed by plan slot, so a shared subgraph
   * computes once per sample.
   *
   * There is no clearing step. Each entry carries the generation it was
   * written in (`stamps`), and starting a new sample, a new channel or a new
   * seam pass is one increment of `gen`. Clearing a 40-node cache 48,000
   * times a second was pure overhead for a cache that is about to be
   * completely overwritten anyway.
   */
  values: Float64Array;
  stamps: Float64Array;
  gen: number;
  /**
   * The generation a block-constant node's cached value belongs to.
   *
   * A second counter rather than a second array. It runs negative while
   * `gen` runs positive, so one stamp slot serves both and a value cached
   * for the block can never be mistaken for one cached for the sample.
   */
  blockGen: number;
  /**
   * Per-node persistent state (oscillator phase, envelope stage, filter delay
   * line) for the left channel, never cleared. Channels past the first get
   * their own array in `laneMemory`: a biquad running on the right channel is
   * a second filter, not the same one fed twice.
   */
  memory: unknown[];
  /** Per-node state for channels other than 0, indexed by channel. */
  laneMemory?: unknown[][];
  params: Record<string, number>;
  gate: boolean;
  /** Live audio for the block being rendered. Absent on the per-sample path. */
  portBlocks?: PortBlocks;
  /**
   * The object `portBlocks` points at while a block renders, kept so a block
   * describing its own inputs costs no allocation. Its keys are the graph's
   * ports and never change.
   */
  portScratch?: Record<string, readonly (Float32Array | undefined)[] | undefined>;
  /** The two-channel pair handed to the main port, reused the same way. */
  inputPair?: (Float32Array | undefined)[];
  /** Frame within the current block, used to index `portBlocks`. */
  frameIndex: number;
  /** Output channel being evaluated: 0 left, 1 right. */
  lane: number;
  /**
   * Block-rate DSP bound to the graph's named kernel slots
   * (`renderers/kernel.ts`). An empty map, or a slot with nothing in it, is a
   * clean passthrough: the graph still runs, it just runs without that stage.
   * Audiocrate core never populates this; a host or a plugin package does.
   */
  kernels?: KernelBindings;
  /** Set by renderBlock while any seam kernel is bound; ASL state advances once per frame. */
  seamBlock?: SeamBlockRuntime;
  /** Zero-filled stand-in handed to a source kernel when nothing is connected upstream. */
  sourceScratch?: Float32Array;
  /** Live `tap.meter` accumulators, keyed by tap id. Created on first use. */
  meters?: Map<string, MeterAccumulator>;
  /** Live `tap.capture` ring buffers, keyed by tap id. Created on first use. */
  captures?: Map<string, CaptureBuffer>;
  /**
   * The host's musical position at the start of the current block
   * (`asl/transportNodes.ts`). Absent means a stopped transport at 120,
   * which is what an offline render or a standalone voice correctly gets.
   *
   * Set once per block, never per sample: transport nodes derive their
   * sample-accurate position from this plus `frameIndex`, which makes them
   * pure functions of the frame. That is what lets them survive a seam
   * graph's two passes over the same tree without double-stepping, and it is
   * why they need no per-node memory at all.
   */
  transport?: TransportSnapshot;
}

export interface CompiledVoice {
  /**
   * The slot of a source kernel at the graph's output, or null for an
   * ordinary ASL graph. Renderers need this to know whether the kernel or the
   * evaluator owns the output block (and therefore whether to mirror channel
   * 0 across the remaining channels).
   */
  readonly sourceSlot: string | null;
  /** Every seam-kernel slot this graph names, in discovery order. */
  readonly seamSlots: readonly string[];
  /**
   * Whether this graph is evaluated once per output channel. True when it
   * reads live audio (an insert processes both sides of a stereo track) or
   * asks which channel it is on (auto-pan, ping-pong), false for a source
   * whose output is the same number on every channel and is cheaper mirrored.
   * `graph.channels` overrides it either way.
   */
  readonly stereo: boolean;
  /** Every live audio input this graph reads, sorted, `input` included. */
  readonly ports: readonly string[];
  /** Tap ids this graph records under (`asl/analysis.ts`), sorted. Empty for a graph with no taps. */
  readonly taps: readonly string[];
  /**
   * How many of this graph's nodes are computed once per block instead of
   * once per sample per channel.
   *
   * A coefficient subtree rooted in parameters has the same value for every
   * sample in a block, and most of a plugin-sized graph is exactly that:
   * curve mappings, mode compares, gain conversions. Reported because it is
   * the difference between a graph that plays and one that does not, and
   * because it is otherwise invisible.
   */
  readonly blockConstantNodes: number;
  /**
   * Reads every tap and resets the meters, so each frame covers exactly the
   * interval since the previous call. Returns null when the graph has no
   * taps, which is the common case and must stay allocation-free.
   */
  drainAnalysis(state: VoiceRuntimeState): AnalysisFrame | null;
  createState(): VoiceRuntimeState;
  noteOn(state: VoiceRuntimeState, params: Record<string, number>): void;
  noteOff(state: VoiceRuntimeState): void;
  renderSample(state: VoiceRuntimeState, sampleRate: number): number;
  /**
   * Renders one block. Returns whether `extras.outputR` was written: a
   * caller that gets `false` must mirror channel 0 itself. Reporting it
   * rather than having the renderer re-derive the rule keeps the two from
   * drifting, which matters because the wrong answer is either a silent
   * right channel or a stereo image collapsed to mono.
   */
  renderBlock(
    state: VoiceRuntimeState,
    sampleRate: number,
    out: Float32Array,
    input?: Float32Array,
    extras?: {
      inputR?: Float32Array;
      outputR?: Float32Array;
      /**
       * Live audio for ports other than `input`, channel-major. A port with
       * no entry here reads 0, the same as an unconnected input.
       */
      ports?: PortBlocks;
      /**
       * The host's musical position at the start of this block. Omitting it
       * leaves whatever the caller already put on the state, so a renderer
       * that sets it once per voice does not have to repeat it per block.
       */
      transport?: TransportSnapshot;
    },
  ): boolean;
}

/** `shape` is one of the SHAPE_ constants. Plaits-style extras use `width` as shapeMod. */
function oscillatorSample(shape: number, phase: number, width = 0.5, freq = 0, sampleRate = 1): number {
  switch (shape) {
    case SHAPE_SAW:
      return 2 * phase - 1;
    case SHAPE_SQUARE:
      return phase < 0.5 ? 1 : -1;
    case SHAPE_TRIANGLE:
      return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    case SHAPE_PULSE: {
      const duty = Math.min(Math.max(width, 1e-4), 1 - 1e-4);
      return phase < duty ? 1 : -1;
    }
    case SHAPE_VARSHAPE:
      return varShapeSample(phase, width);
    case SHAPE_HARMONIC:
      return harmonicSample(phase, width, freq, sampleRate);
    default:
      return Math.sin(2 * Math.PI * phase);
  }
}

function varShapeSample(phase: number, shapeMod: number): number {
  const t = shapeMod < 0 ? 0 : shapeMod > 1 ? 1 : shapeMod;
  const tri = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
  const saw = 2 * phase - 1;
  const square = phase < 0.5 ? 1 : -1;
  if (t < 0.5) {
    const mix = t * 2;
    return tri * (1 - mix) + saw * mix;
  }
  const mix = (t - 0.5) * 2;
  return saw * (1 - mix) + square * mix;
}

function harmonicSample(phase: number, tilt: number, freq: number, sampleRate: number): number {
  const freqNorm = freq / sampleRate;
  let maxHarm = Math.min(16, Math.floor(0.5 / Math.max(freqNorm, 1e-9)));
  if (maxHarm < 1) maxHarm = 1;
  const exponent = 2 * (1 - (tilt < 0 ? 0 : tilt > 1 ? 1 : tilt));
  let norm = 0;
  let sample = 0;
  for (let h = 0; h < maxHarm; h++) {
    const n = h + 1;
    const amp = 1 / Math.pow(n, exponent);
    norm += amp;
    const harmPhase = phase * n;
    sample += amp * Math.sin(2 * Math.PI * (harmPhase - Math.floor(harmPhase)));
  }
  return norm > 0 ? sample / norm : 0;
}

/**
 * `offset` shifts where the waveform is *read* without touching where it has
 * got to, so two LFOs at one rate can sit a quarter cycle apart and still be
 * the same clock. Stored phase is left alone deliberately: an offset that
 * moved it would make every change to the knob a jump rather than a rotation.
 *
 * Zero is exact rather than nearly exact. `mem.phase` is always in 0..1, so
 * `(mem.phase + 0) % 1` is `mem.phase` to the bit, which is what lets this be
 * added without moving a single existing golden sample.
 */
function renderOsc(
  shape: number,
  mem: OscMemory,
  freq: number,
  sampleRate: number,
  width: number,
  offset = 0,
): number {
  const increment = freq / sampleRate;
  const shift = (phase: number): number => {
    if (offset === 0) return phase;
    const shifted = (phase + offset) % 1;
    return shifted < 0 ? shifted + 1 : shifted;
  };
  if (shape === SHAPE_SUPERSQUARE) {
    const ratio = 1 + (width < 0 ? 0 : width > 1 ? 1 : width) * 3;
    mem.phase += increment;
    mem.slavePhase += increment * ratio;
    if (mem.phase >= 1) {
      mem.phase -= 1;
      mem.slavePhase = mem.phase * ratio;
    }
    if (mem.slavePhase >= 1) mem.slavePhase -= Math.floor(mem.slavePhase);
    const master = 2 * shift(mem.phase) - 1;
    const slave = shift(mem.slavePhase) < 0.5 ? 1 : -1;
    return (master + slave) * 0.5;
  }
  const sample = oscillatorSample(shape, shift(mem.phase), width, freq, sampleRate);
  mem.phase = (mem.phase + increment) % 1;
  return sample;
}

/**
 * The state store for the channel being rendered. Channel 0 uses
 * `state.memory` directly so a mono graph keeps exactly the object identity,
 * allocation count and behaviour it had before channels existed.
 */
function memoryFor(state: VoiceRuntimeState): unknown[] {
  const lane = state.lane;
  if (!lane) return state.memory;
  let lanes = state.laneMemory;
  if (!lanes) {
    lanes = [];
    state.laneMemory = lanes;
  }
  let mem = lanes[lane];
  if (!mem) {
    // Filled rather than left holey: a packed array of the graph's own size
    // is what makes the per-sample read a plain indexed load.
    mem = new Array<unknown>(state.memory.length).fill(undefined);
    lanes[lane] = mem;
  }
  return mem;
}

function getMemory<T>(state: VoiceRuntimeState, slot: number, init: () => T): T {
  const store = memoryFor(state);
  let mem = store[slot] as T | undefined;
  if (mem === undefined) {
    mem = init();
    store[slot] = mem;
  }
  return mem;
}

/**
 * An attack/release follower's state, with the two one-pole coefficients it
 * is running and the times they came from.
 *
 * `1 - exp(-1 / (time * sampleRate))` is a transcendental per sample, twice
 * over in a compressor, for two numbers that a knob changes at most a few
 * times a second. Same NaN-key discipline as `BiquadMemory`: bit-identical
 * output, the maths done when something actually moved.
 */
interface FollowerMemory {
  env: number;
  /** Attack time and its coefficient. */
  ka: number;
  ca: number;
  /** Release time and its coefficient. */
  kr: number;
  cr: number;
  sr: number;
}

function newFollower(): FollowerMemory {
  return { env: 0, ka: NaN, ca: 0, kr: NaN, cr: 0, sr: NaN };
}

/**
 * The follower coefficient for `time`, cached in whichever of the two slots
 * belongs to this direction. Returns the coefficient to step `env` by.
 */
function followerCoeff(mem: FollowerMemory, time: number, sampleRate: number, rising: boolean): number {
  if (mem.sr !== sampleRate) {
    mem.sr = sampleRate;
    mem.ka = NaN;
    mem.kr = NaN;
  }
  if (rising) {
    if (mem.ka !== time) {
      mem.ca = 1 - Math.exp(-1 / (time * sampleRate));
      mem.ka = time;
    }
    return mem.ca;
  }
  if (mem.kr !== time) {
    mem.cr = 1 - Math.exp(-1 / (time * sampleRate));
    mem.kr = time;
  }
  return mem.cr;
}

function recordMeter(state: VoiceRuntimeState, id: string, value: number): void {
  let meters = state.meters;
  if (!meters) {
    meters = new Map();
    state.meters = meters;
  }
  let acc = meters.get(id);
  if (!acc) {
    acc = { peak: 0, sumSq: 0, count: 0 };
    meters.set(id, acc);
  }
  const magnitude = value < 0 ? -value : value;
  if (magnitude > acc.peak) acc.peak = magnitude;
  acc.sumSq += value * value;
  acc.count += 1;
}

function recordCapture(state: VoiceRuntimeState, id: string, windowSize: number, value: number): void {
  let captures = state.captures;
  if (!captures) {
    captures = new Map();
    state.captures = captures;
  }
  let buffer = captures.get(id);
  if (!buffer) {
    buffer = { samples: new Float32Array(windowSize), write: 0, filled: false };
    captures.set(id, buffer);
  }
  buffer.samples[buffer.write] = value;
  buffer.write += 1;
  if (buffer.write >= buffer.samples.length) {
    buffer.write = 0;
    buffer.filled = true;
  }
}

type LooperMem = {
  ring: Float32Array;
  play: Float32Array;
  undo: Float32Array | null;
  writeAbs: number;
  startAbs: number;
  targetLen: number;
  playLen: number;
  playRead: number;
  hasUndo: boolean;
  recording: boolean;
  armed: boolean;
  closing: boolean;
  prevRec: boolean;
  prevPlay: boolean;
  prevClear: boolean;
  prevOverdub: boolean;
  prevUndo: boolean;
};

type LooperRuntime = {
  gen: number;
  out: number;
  start: number;
  end: number;
  mem: LooperMem;
};

export function compileVoice(graph: ASLGraphDescriptor): CompiledVoice {
  const plan = buildPlan(graph.output);
  const root = plan.root;
  const slotCount = plan.count;
  const seamNodes: PlanNode[] = [...plan.seams];
  const ports = audioPortNames(graph);
  const taps = plan.tapIds;
  const looperRuntimes = new WeakMap<VoiceRuntimeState, WeakMap<LooperBox, LooperRuntime>>();
  const stereo =
    graph.channels === 1
      ? false
      : graph.channels === 2
        ? true
        : ports.length > 0 || plan.usesLane;
  // A source kernel only means anything as the graph's output: it replaces
  // the whole per-sample evaluation, so there is nothing sensible for a
  // second one, or a buried one, to do.
  const sourceNode = root.kind === 'kernel' && root.m !== 0 ? root : null;
  /** True only when a `param` named `input` exists to receive it. */
  const writesScalarInput = plan.readsScalarInput;
  /**
   * Whether a stereo pass over this graph can be skipped when everything
   * feeding it is mono.
   *
   * A stereo graph runs the whole tree once per channel, and it has to: the
   * two channels carry different samples and a filter needs its own state on
   * each side. But an insert on a mono track, which is most guitar and most
   * vocal tracks, is handed the same samples twice. Two evaluations of the
   * same code over the same input, from per-channel state that started
   * identical, produce identical output, so the second one is the same block
   * computed a second time and thrown at the right speaker.
   *
   * Two things break that equality and both are decided here rather than
   * guessed at: a graph that asks which channel it is on is allowed to
   * differ, and a graph that draws random numbers will differ. Everything
   * else can be mirrored, which halves what a mono track's inserts cost.
   */
  const mirrorsMonoInput = stereo && !plan.usesLane && !plan.usesRandom;
  /**
   * Rebuilt into on every block instead of allocated: same keys every time,
   * so the object keeps one hidden class and the audio thread allocates
   * nothing to describe its own inputs.
   */
  const portScratchKeys = ports;

  /**
   * Evaluate one node, through the per-sample cache.
   *
   * The wiring kinds live here and everything else is one call away, which
   * is a performance decision rather than a taste one. A graph's arithmetic
   * spine is a deep recursion: twenty gains in series is forty nested calls
   * per sample per channel. Recursing through a function with seventy cases
   * in it means forty stack frames sized for the widest of those cases, and
   * on an arithmetic-heavy patch that frame traffic outweighs the arithmetic
   * several times over. Keeping the spine in a small function keeps the
   * frames small.
   *
   * The split is by cost, not by category: a kind belongs here if the work
   * it does is smaller than the call that would reach it.
   */
  function evalNode(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const slot = node.i;
    // Two generations, one cache. A coefficient subtree rooted in parameters
    // is stamped with the block's generation and computed once; everything
    // else is stamped with the sample's.
    const stamp = node.hoist === 1 ? state.blockGen : state.gen;
    if (state.stamps[slot] === stamp) return state.values[slot]!;

    let result: number;
    switch (node.kind) {
      case 'const':
        result = node.c;
        break;

      case 'mul':
        result = evalNode(node.inputs.a!, state, sampleRate) * evalNode(node.inputs.b!, state, sampleRate);
        break;

      case 'add':
        result = evalNode(node.inputs.a!, state, sampleRate) + evalNode(node.inputs.b!, state, sampleRate);
        break;

      case 'param':
        result = state.params[node.name] ?? 0;
        break;

      case 'port': {
        const name = node.name;
        const blocks = state.portBlocks?.[name];
        if (!blocks) {
          // No block wired: fall back to the scalar of the same name. That is
          // the per-sample path (`renderSample`, OfflineRenderer), where a
          // caller feeds one value at a time, and it is why every graph
          // written against the old `params.input` still runs unchanged.
          result = state.params[name] ?? 0;
          break;
        }
        const fixed = node.m;
        const channel = fixed < 0 ? state.lane : fixed;
        // A fixed channel that the source does not have reads the one it does
        // have: `audio.right()` on a mono send is that send, not silence.
        const block = blocks[channel] ?? blocks[0];
        result = block?.[state.frameIndex] ?? 0;
        break;
      }

      case 'lane':
        result = state.lane;
        break;

      case 'range': {
        const source = evalNode(node.inputs.source!, state, sampleRate); // -1..1
        result = node.rangeMin + ((source + 1) / 2) * (node.rangeMax - node.rangeMin);
        break;
      }

      case 'mix': {
        // A loop, not a reduce: the callback would be one closure per node
        // per sample, allocated on the audio thread to add up a handful of
        // numbers.
        const sources = node.list;
        let sum = 0;
        if (sources) {
          for (let k = 0; k < sources.length; k++) sum += evalNode(sources[k]!, state, sampleRate);
        }
        result = sum;
        break;
      }

      default:
        result = evalOther(node, state, sampleRate);
        break;
    }

    state.values[slot] = result;
    state.stamps[slot] = stamp;
    return result;
  }

  /** Everything whose own work is worth more than a call to reach it. */
  function evalOther(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    let result: number;
    switch (node.kind) {
      case 'const':
      case 'param':
      case 'port':
      case 'lane':
      case 'mul':
      case 'add':
      case 'mix':
      case 'range':
        // Handled by evalNode; unreachable, and stated rather than left to a
        // fallthrough so adding a kind above cannot silently lose it here.
        throw new Error(`ASL node kind handled inline: ${node.kind}`);

      case 'meter':
      case 'capture': {
        const value = evalNode(node.inputs.input!, state, sampleRate);
        result = value;
        // Two guards, both load-bearing. A seam graph evaluates the whole
        // tree twice per sample (collect, then apply), so recording on both
        // would double every meter. And a stereo graph evaluates once per
        // channel, so recording on both would interleave a capture into
        // nonsense; a tap reads the left channel, and a graph that wants the
        // mono sum taps `audio.left().add(audio.right()).mul(0.5)`.
        if (state.seamBlock?.phase === 'collect' || state.lane !== 0) break;
        if (node.kind === 'meter') recordMeter(state, node.name, value);
        else recordCapture(state, node.name, node.c, value);
        break;
      }

      case 'toFrequency': {
        const note = evalNode(node.inputs.note!, state, sampleRate);
        result = 440 * Math.pow(2, (note - 69) / 12);
        break;
      }

      case 'osc': {
        const freq = evalNode(node.inputs.freq!, state, sampleRate);
        const width = node.inputs.width ? evalNode(node.inputs.width, state, sampleRate) : 0.5;
        const shape = node.inputs.type
          ? Math.min(7, Math.max(0, Math.round(evalNode(node.inputs.type, state, sampleRate))))
          : node.m;
        const mem = getMemory<OscMemory>(state, node.i, () => ({ phase: 0, slavePhase: 0 }));
        result = renderOsc(shape, mem, freq, sampleRate, width);
        break;
      }

      case 'lfo': {
        const rate = evalNode(node.inputs.rate!, state, sampleRate);
        const width = node.inputs.width ? evalNode(node.inputs.width, state, sampleRate) : 0.5;
        const shape = node.inputs.type
          ? Math.min(7, Math.max(0, Math.round(evalNode(node.inputs.type, state, sampleRate))))
          : node.m;
        const offset = node.inputs.phase ? evalNode(node.inputs.phase, state, sampleRate) : 0;
        const mem = getMemory<OscMemory & { prevReset: number }>(state, node.i, () => ({
          phase: 0,
          slavePhase: 0,
          prevReset: 0,
        }));
        // Back to the start of the cycle, not to the start of the *next* one:
        // an LFO is a shape being read, so its reset lands on the first sample
        // of the shape. A clock, being an event, fires on the sample it is
        // reset instead.
        if (resetRose(node, state, sampleRate, mem)) {
          mem.phase = 0;
          mem.slavePhase = 0;
        }
        result = renderOsc(shape, mem, rate, sampleRate, width, offset);
        break;
      }

      case 'adsr':
        result = evalAdsr(node, state, sampleRate);
        break;

      case 'filterLowpass':
        result = evalRbJ(node, state, sampleRate, 'lowpass');
        break;

      case 'filterHighpass':
        result = evalRbJ(node, state, sampleRate, 'highpass');
        break;

      case 'filterBandpass':
        result = evalRbJ(node, state, sampleRate, 'bandpass');
        break;

      case 'filterNotch':
        result = evalRbJ(node, state, sampleRate, 'notch');
        break;

      case 'filterPeaking':
        result = evalPeaking(node, state, sampleRate);
        break;

      case 'filterLowShelf':
        result = evalShelf(node, state, sampleRate, 'low');
        break;

      case 'filterHighShelf':
        result = evalShelf(node, state, sampleRate, 'high');
        break;

      case 'filterAllpass':
        result = evalAllpass(node, state, sampleRate);
        break;

      case 'onePoleLowpass':
        result = evalOnePole(node, state, sampleRate, 'low');
        break;

      case 'onePoleHighpass':
        result = evalOnePole(node, state, sampleRate, 'high');
        break;

      case 'svf':
        result = evalSvf(node, state, sampleRate);
        break;

      case 'ladder':
        result = evalLadder(node, state, sampleRate);
        break;

      case 'comb':
        result = evalComb(node, state, sampleRate);
        break;

      case 'bitcrush':
        result = evalBitcrush(node, state, sampleRate);
        break;

      case 'downsample':
        result = evalDownsample(node, state, sampleRate);
        break;

      case 'rectify':
        result = evalRectify(node, state, sampleRate);
        break;

      case 'slew':
        result = evalSlew(node, state, sampleRate);
        break;

      case 'sampleHold':
        result = evalSampleHold(node, state, sampleRate);
        break;

      case 'compare':
        result = evalCompare(node, state, sampleRate);
        break;

      case 'compressor':
        result = evalCompressor(node, state, sampleRate);
        break;

      case 'expander':
        result = evalExpander(node, state, sampleRate);
        break;

      case 'transient':
        result = evalTransient(node, state, sampleRate);
        break;

      case 'impulse':
        result = evalImpulse(node, state, sampleRate);
        break;

      case 'reverse':
        result = evalReverse(node, state, sampleRate);
        break;

      case 'looper':
        result = evalLooper(node, state, sampleRate);
        break;

      case 'select':
        result = evalSelect(node, state, sampleRate);
        break;

      case 'waveshape':
        result = evalWaveshape(node, state, sampleRate);
        break;

      case 'breakpoints':
        result = evalBreakpoints(node, state, sampleRate);
        break;

      case 'rms':
        result = evalRms(node, state, sampleRate);
        break;

      case 'peak':
        result = evalPeak(node, state, sampleRate);
        break;

      case 'onset':
        result = evalOnset(node, state, sampleRate);
        break;

      case 'pitch':
        result = evalPitch(node, state, sampleRate);
        break;

      case 'filterSlope':
        result = evalFilterSlope(node, state, sampleRate);
        break;

      case 'wavetable':
        result = evalWavetable(node, state, sampleRate);
        break;

      case 'samplePlay':
        result = evalSamplePlay(node, state, sampleRate);
        break;

      case 'grain':
        result = evalGrain(node, state, sampleRate);
        break;

      case 'pitchShift':
        result = evalPitchShift(node, state, sampleRate);
        break;

      case 'panLaw':
        result = evalPanLaw(node, state, sampleRate);
        break;

      case 'transport':
        result = evalTransport(node, state, sampleRate);
        break;

      case 'clock':
        result = evalClock(node, state, sampleRate);
        break;

      case 'clockDivide':
        result = evalClockDivide(node, state, sampleRate);
        break;

      case 'clockMultiply':
        result = evalClockMultiply(node, state, sampleRate);
        break;

      case 'logic':
        result = evalLogic(node, state, sampleRate);
        break;

      case 'flipFlop':
        result = evalFlipFlop(node, state, sampleRate);
        break;

      case 'quantize':
        result = evalQuantize(node, state, sampleRate);
        break;

      case 'euclidean':
        result = evalEuclidean(node, state, sampleRate);
        break;

      case 'random':
        result = evalRandom(node, state, sampleRate);
        break;

      case 'trigger':
        result = evalTrigger(node, state, sampleRate);
        break;

      case 'pulse':
        result = evalPulse(node, state, sampleRate);
        break;

      case 'dahdsr':
        result = evalDahdsr(node, state, sampleRate);
        break;

      case 'sequencer':
        result = evalSequencer(node, state, sampleRate);
        break;

      case 'noise':
        result = evalNoise(node, state, sampleRate);
        break;

      case 'delay':
        result = evalDelay(node, state, sampleRate);
        break;

      case 'clip':
        result = evalClip(node, state, sampleRate);
        break;

      case 'dcBlock':
        result = evalDcBlock(node, state, sampleRate);
        break;

      case 'envFollow':
        result = evalEnvFollow(node, state, sampleRate);
        break;

      case 'kernel': {
        if (node.m !== 0) {
          // Only meaningful as the graph output, where renderBlock handles it
          // before the tree is ever walked.
          result = 0;
          break;
        }
        const processor = state.kernels?.get(node.slot);
        const block = state.seamBlock;
        if (processor && block?.phase === 'collect') {
          const input = evalNode(node.inputs.input!, state, sampleRate);
          const buffers = block.buffers[node.i];
          if (buffers) buffers.in[block.index] = input;
          result = 0;
          break;
        }
        if (processor && block?.phase === 'apply') {
          result = block.buffers[node.i]?.out[block.index] ?? 0;
          break;
        }
        const input = evalNode(node.inputs.input!, state, sampleRate);
        // No bound kernel, or a kernel with no per-sample path: pass through
        // rather than emit silence, so an AudioMaterial whose asset never loaded
        // still sounds like the rest of its graph.
        result = processor?.processSeamSample ? processor.processSeamSample(input) : input;
        break;
      }

      default:
        throw new Error(`Unknown ASL node kind: ${node.kind satisfies never}`);
    }

    return result;
  }

  function evalAdsr(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const { a, d, s, r } = node.params as { a: number; d: number; s: number; r: number };
    const velocity = evalNode(node.inputs.trigger!, state, sampleRate);
    const mem = getMemory<AdsrMemory>(state, node.i, () => ({
      stage: 'idle',
      level: 0,
      peak: 0,
      stageElapsed: 0,
      stageStartLevel: 0,
      lastGate: false,
    }));

    if (state.gate && !mem.lastGate) {
      mem.stage = 'attack';
      mem.peak = velocity;
      mem.stageElapsed = 0;
      mem.stageStartLevel = mem.level;
    } else if (!state.gate && mem.lastGate) {
      mem.stage = 'release';
      mem.stageElapsed = 0;
      mem.stageStartLevel = mem.level;
    }
    mem.lastGate = state.gate;

    const dt = 1 / sampleRate;

    switch (mem.stage) {
      case 'idle':
        mem.level = 0;
        break;
      case 'attack': {
        mem.stageElapsed += dt;
        const t = Math.min(mem.stageElapsed / Math.max(a, 1e-6), 1);
        mem.level = mem.stageStartLevel + (mem.peak - mem.stageStartLevel) * t;
        if (t >= 1) {
          mem.stage = 'decay';
          mem.stageElapsed = 0;
          mem.stageStartLevel = mem.level;
        }
        break;
      }
      case 'decay': {
        mem.stageElapsed += dt;
        const target = s * mem.peak;
        const t = Math.min(mem.stageElapsed / Math.max(d, 1e-6), 1);
        mem.level = mem.stageStartLevel + (target - mem.stageStartLevel) * t;
        if (t >= 1) mem.stage = 'sustain';
        break;
      }
      case 'sustain':
        mem.level = s * mem.peak;
        break;
      case 'release': {
        mem.stageElapsed += dt;
        const t = Math.min(mem.stageElapsed / Math.max(r, 1e-6), 1);
        mem.level = mem.stageStartLevel * (1 - t);
        if (t >= 1) {
          mem.stage = 'idle';
          mem.level = 0;
        }
        break;
      }
    }

    return mem.level;
  }

  /** Stores the coefficients, already normalised by a0, and the inputs behind them. */
  function setBiquad(
    mem: BiquadMemory,
    k0: number,
    k1: number,
    k2: number,
    k3: number,
    b0: number,
    b1: number,
    b2: number,
    a0: number,
    a1: number,
    a2: number,
  ): void {
    mem.n0 = b0 / a0;
    mem.n1 = b1 / a0;
    mem.n2 = b2 / a0;
    mem.d1 = a1 / a0;
    mem.d2 = a2 / a0;
    mem.k0 = k0;
    mem.k1 = k1;
    mem.k2 = k2;
    mem.k3 = k3;
  }

  function tickBiquad(mem: BiquadMemory, input: number): number {
    const y = mem.n0 * input + mem.n1 * mem.x1 + mem.n2 * mem.x2 - mem.d1 * mem.y1 - mem.d2 * mem.y2;
    mem.x2 = mem.x1;
    mem.x1 = input;
    mem.y2 = mem.y1;
    mem.y1 = y;
    return y;
  }

  // RBJ audio-EQ-cookbook. Coefficients are recomputed whenever cutoff or q
  // moves, and only then: see `BiquadMemory`.
  function evalRbJ(
    node: PlanNode,
    state: VoiceRuntimeState,
    sampleRate: number,
    kind: 'lowpass' | 'highpass' | 'bandpass' | 'notch',
  ): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const cutoff = evalNode(node.inputs.cutoff!, state, sampleRate);
    const q = evalNode(node.inputs.q!, state, sampleRate);
    const mem = getMemory<BiquadMemory>(state, node.i, newBiquad);

    if (mem.k0 !== cutoff || mem.k1 !== q || mem.k2 !== sampleRate) {
      const clampedCutoff = Math.min(Math.max(cutoff, 1), sampleRate / 2 - 1);
      const omega = (2 * Math.PI * clampedCutoff) / sampleRate;
      const sinw = Math.sin(omega);
      const cosw = Math.cos(omega);
      const alpha = sinw / (2 * Math.max(q, 1e-4));

      let b0: number;
      let b1: number;
      let b2: number;
      const a0 = 1 + alpha;
      const a1 = -2 * cosw;
      const a2 = 1 - alpha;
      if (kind === 'lowpass') {
        b0 = (1 - cosw) / 2;
        b1 = 1 - cosw;
        b2 = (1 - cosw) / 2;
      } else if (kind === 'highpass') {
        b0 = (1 + cosw) / 2;
        b1 = -(1 + cosw);
        b2 = (1 + cosw) / 2;
      } else if (kind === 'bandpass') {
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
      } else {
        b0 = 1;
        b1 = -2 * cosw;
        b2 = 1;
      }
      setBiquad(mem, cutoff, q, sampleRate, 0, b0, b1, b2, a0, a1, a2);
    }

    return tickBiquad(mem, input);
  }

  function evalNoise(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const white = Math.random() * 2 - 1;
    const color = node.inputs.color
      ? Math.min(5, Math.max(0, Math.round(evalNode(node.inputs.color, state, sampleRate))))
      : node.m;
    if (color === 0) return white;
    const mem = getMemory<{ b0: number; b1: number; b2: number; brown: number; lastWhite: number; lastPink: number }>(
      state,
      node.i,
      () => ({ b0: 0, b1: 0, b2: 0, brown: 0, lastWhite: 0, lastPink: 0 }),
    );
    const pink = () => {
      mem.b0 = 0.99886 * mem.b0 + white * 0.0555179;
      mem.b1 = 0.99332 * mem.b1 + white * 0.0750759;
      mem.b2 = 0.969 * mem.b2 + white * 0.153852;
      return Math.min(1, Math.max(-1, (mem.b0 + mem.b1 + mem.b2 + white * 0.3104856) * 0.55));
    };
    const brown = () => {
      mem.brown = (mem.brown + white * 0.02) * 0.996;
      return Math.min(1, Math.max(-1, mem.brown * 3.5));
    };
    if (color === 1) return pink();
    if (color === 2) return brown();
    if (color === 3) {
      const p = pink();
      const blue = (p - mem.lastPink) * 8;
      mem.lastPink = p;
      return Math.min(1, Math.max(-1, blue));
    }
    if (color === 4) {
      const violet = (white - mem.lastWhite) * 0.85;
      mem.lastWhite = white;
      return Math.min(1, Math.max(-1, violet));
    }
    const p = pink();
    const b = brown();
    return Math.min(1, Math.max(-1, p * 0.65 + (white - b * 0.35) * 0.4));
  }

  function evalDelay(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const timeSec = evalNode(node.inputs.timeSec!, state, sampleRate);
    const feedback = evalNode(node.inputs.feedback!, state, sampleRate);
    const wet = evalNode(node.inputs.mix!, state, sampleRate);
    const mem = getMemory<{ buf: Float32Array; idx: number; pos: number; ready: boolean; c: number; sr: number }>(
      state,
      node.i,
      () => ({
        // Sized once, on the first sample this node ever runs. The line length
        // is a graph constant; re-deriving it 48,000 times a second was work
        // for an answer only the allocation above ever reads.
        buf: new Float32Array(Math.max(2, Math.ceil(Math.max(node.c, 1 / sampleRate) * sampleRate) + 2)),
        idx: 0,
        pos: 0,
        ready: false,
        c: 0,
        sr: NaN,
      }),
    );
    const target = Math.min(Math.max(timeSec, 0) * sampleRate, mem.buf.length - 2);

    // The read pointer is glided to its target, never teleported.
    //
    // A delay line is the one node where a parameter step is not a small
    // discontinuity, it is a jump to a different part of the buffer: the
    // output leaps from one sample to an unrelated one and the result is a
    // click. Moving the time control at all, which is what dragging a knob or
    // running an automation lane does, therefore produced a click per update
    // and a continuous crackle while the control moved. Nothing about the
    // parameter's own resolution helps, because the artefact is in the
    // pointer, not the value.
    //
    // Gliding gives a brief pitch bend while the time changes instead:
    // interpolating the read pointer rather than jumping it.
    //
    // The first sample takes the target exactly. A delay whose time never
    // moves is therefore sample-for-sample what it was before this existed.
    if (mem.sr !== sampleRate) {
      // ~20 ms to close the gap: fast enough to feel immediate on a knob,
      // slow enough that the glide is a bend rather than a click.
      mem.c = 1 - Math.exp(-1 / (0.02 * sampleRate));
      mem.sr = sampleRate;
    }
    if (!mem.ready) {
      mem.pos = target;
      mem.ready = true;
    } else {
      mem.pos += (target - mem.pos) * mem.c;
    }
    const read = mem.idx - mem.pos;
    const i0 = ((Math.floor(read) % mem.buf.length) + mem.buf.length) % mem.buf.length;
    const i1 = (i0 + 1) % mem.buf.length;
    const frac = read - Math.floor(read);
    const delayed = mem.buf[i0]! * (1 - frac) + mem.buf[i1]! * frac;
    mem.buf[mem.idx] = input + delayed * Math.min(Math.max(feedback, -0.99), 0.99);
    mem.idx = (mem.idx + 1) % mem.buf.length;
    const mix = Math.min(Math.max(wet, 0), 1);
    return input * (1 - mix) + delayed * mix;
  }

  function evalClip(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const drive = Math.max(evalNode(node.inputs.drive!, state, sampleRate), 1e-4);
    const driven = input * drive;
    if (node.m === 1) return Math.min(1, Math.max(-1, driven));
    return Math.tanh(driven);
  }

  function evalDcBlock(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const mem = getMemory<{ x1: number; y1: number }>(state, node.i, () => ({ x1: 0, y1: 0 }));
    const y = input - mem.x1 + 0.995 * mem.y1;
    mem.x1 = input;
    mem.y1 = y;
    return y;
  }

  function evalEnvFollow(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const attack = Math.max(evalNode(node.inputs.attack!, state, sampleRate), 1e-5);
    const release = Math.max(evalNode(node.inputs.release!, state, sampleRate), 1e-5);
    const mem = getMemory<FollowerMemory>(state, node.i, newFollower);
    const target = Math.abs(input);
    const rising = target > mem.env;
    const coeff = followerCoeff(mem, rising ? attack : release, sampleRate, rising);
    mem.env += (target - mem.env) * coeff;
    return mem.env;
  }

  // RBJ audio-EQ-cookbook peaking (bell) biquad: boosts/cuts by `gainDb`
  // around `freq`, unity elsewhere. At gainDb=0 the b and a coefficients are
  // identical (A=1), so it degenerates to an exact bypass, not merely a
  // no-op-ish approximation.
  function evalPeaking(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const freq = evalNode(node.inputs.freq!, state, sampleRate);
    const gainDb = evalNode(node.inputs.gainDb!, state, sampleRate);
    const q = evalNode(node.inputs.q!, state, sampleRate);
    const mem = getMemory<BiquadMemory>(state, node.i, newBiquad);

    // Three inputs decide the coefficients here, so the cache key folds gain
    // and Q together rather than growing a fourth field.
    if (mem.k0 !== freq || mem.k1 !== gainDb || mem.k2 !== q || mem.k3 !== sampleRate) {
      const clampedFreq = Math.min(Math.max(freq, 1), sampleRate / 2 - 1);
      const a = Math.pow(10, gainDb / 40);
      const omega = (2 * Math.PI * clampedFreq) / sampleRate;
      const alpha = Math.sin(omega) / (2 * Math.max(q, 1e-4));
      const cosw = Math.cos(omega);

      const b0 = 1 + alpha * a;
      const b1 = -2 * cosw;
      const b2 = 1 - alpha * a;
      const a0 = 1 + alpha / a;
      const a1 = -2 * cosw;
      const a2 = 1 - alpha / a;
      setBiquad(mem, freq, gainDb, q, sampleRate, b0, b1, b2, a0, a1, a2);
    }

    return tickBiquad(mem, input);
  }

  // RBJ audio-EQ-cookbook low/high shelf, matching the amp kernel's
  // band 0 / band 4 design (Q = 0.707). At gainDb === 0 the native kernel
  // swaps in an identity biquad; do the same so a 0 dB shelf is an exact
  // bypass, not a near-bypass.
  function evalShelf(node: PlanNode, state: VoiceRuntimeState, sampleRate: number, kind: 'low' | 'high'): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const freq = evalNode(node.inputs.freq!, state, sampleRate);
    const gainDb = evalNode(node.inputs.gainDb!, state, sampleRate);
    const q = evalNode(node.inputs.q!, state, sampleRate);
    const mem = getMemory<BiquadMemory>(state, node.i, newBiquad);

    if (gainDb === 0) {
      mem.x2 = mem.x1;
      mem.x1 = input;
      mem.y2 = mem.y1;
      mem.y1 = input;
      // The cache is invalidated rather than left holding whatever was in it
      // before the gain reached zero, so leaving bypass recomputes.
      mem.k0 = NaN;
      return input;
    }

    if (mem.k0 !== freq || mem.k1 !== gainDb || mem.k2 !== q || mem.k3 !== sampleRate) {
      const clampedFreq = Math.min(Math.max(freq, 1), sampleRate / 2 - 1);
      const a = Math.pow(10, gainDb / 40);
      const omega = (2 * Math.PI * clampedFreq) / sampleRate;
      const sinw = Math.sin(omega);
      const cosw = Math.cos(omega);
      const alpha = (sinw / 2) * Math.sqrt((a + 1 / a) * (1 / Math.max(q, 1e-4) - 1) + 2);
      const sqA = Math.sqrt(a);

      let b0: number;
      let b1: number;
      let b2: number;
      let a0: number;
      let a1: number;
      let a2: number;

      if (kind === 'low') {
        a0 = a + 1 + (a - 1) * cosw + 2 * sqA * alpha;
        b0 = a * (a + 1 - (a - 1) * cosw + 2 * sqA * alpha);
        b1 = 2 * a * (a - 1 - (a + 1) * cosw);
        b2 = a * (a + 1 - (a - 1) * cosw - 2 * sqA * alpha);
        a1 = -2 * (a - 1 + (a + 1) * cosw);
        a2 = a + 1 + (a - 1) * cosw - 2 * sqA * alpha;
      } else {
        a0 = a + 1 - (a - 1) * cosw + 2 * sqA * alpha;
        b0 = a * (a + 1 + (a - 1) * cosw + 2 * sqA * alpha);
        b1 = -2 * a * (a - 1 + (a + 1) * cosw);
        b2 = a * (a + 1 + (a - 1) * cosw - 2 * sqA * alpha);
        a1 = 2 * (a - 1 - (a + 1) * cosw);
        a2 = a + 1 - (a - 1) * cosw - 2 * sqA * alpha;
      }
      setBiquad(mem, freq, gainDb, q, sampleRate, b0, b1, b2, a0, a1, a2);
    }

    return tickBiquad(mem, input);
  }

  function evalAllpass(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const cutoff = evalNode(node.inputs.cutoff!, state, sampleRate);
    const q = evalNode(node.inputs.q!, state, sampleRate);
    const mem = getMemory<BiquadMemory>(state, node.i, newBiquad);

    if (mem.k0 !== cutoff || mem.k1 !== q || mem.k2 !== sampleRate) {
      const clampedCutoff = Math.min(Math.max(cutoff, 1), sampleRate / 2 - 1);
      const omega = (2 * Math.PI * clampedCutoff) / sampleRate;
      const sinw = Math.sin(omega);
      const cosw = Math.cos(omega);
      const alpha = sinw / (2 * Math.max(q, 1e-4));

      const b0 = 1 - alpha;
      const b1 = -2 * cosw;
      const b2 = 1 + alpha;
      const a0 = 1 + alpha;
      const a1 = -2 * cosw;
      const a2 = 1 - alpha;
      setBiquad(mem, cutoff, q, sampleRate, 0, b0, b1, b2, a0, a1, a2);
    }

    return tickBiquad(mem, input);
  }

  function evalOnePole(
    node: PlanNode,
    state: VoiceRuntimeState,
    sampleRate: number,
    kind: 'low' | 'high',
  ): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const cutoff = evalNode(node.inputs.cutoff!, state, sampleRate);
    const mem = getMemory<{ y: number; k: number; sr: number; g: number }>(state, node.i, () => ({
      y: 0,
      k: NaN,
      sr: NaN,
      g: 0,
    }));
    if (mem.k !== cutoff || mem.sr !== sampleRate) {
      mem.sr = sampleRate;
      const clampedCutoff = Math.min(Math.max(cutoff, 1), sampleRate / 2 - 1);
      mem.g = 1 - Math.exp((-2 * Math.PI * clampedCutoff) / sampleRate);
      mem.k = cutoff;
    }
    mem.y += mem.g * (input - mem.y);
    return kind === 'low' ? mem.y : input - mem.y;
  }

  function evalSvf(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const cutoff = evalNode(node.inputs.cutoff!, state, sampleRate);
    const q = evalNode(node.inputs.q!, state, sampleRate);
    const mem = getMemory<{ low: number; band: number; k: number; sr: number; f: number; damp: number }>(
      state,
      node.i,
      () => ({ low: 0, band: 0, k: NaN, sr: NaN, f: 0, damp: 0 }),
    );

    if (mem.k !== cutoff || mem.sr !== sampleRate) {
      const clampedCutoff = Math.min(Math.max(cutoff, 1), sampleRate * 0.25);
      mem.f = 2 * Math.sin((Math.PI * clampedCutoff) / sampleRate);
      mem.k = cutoff;
      mem.sr = sampleRate;
    }
    // Cheap enough to keep unconditional; there is no transcendental in it.
    const damp = Math.min(1.98, Math.max(0.05, 1 / Math.max(q, 0.05)));
    const f = mem.f;
    mem.low += f * mem.band;
    const high = input - mem.low - damp * mem.band;
    mem.band += f * high;
    if (node.m === 1) return high;
    if (node.m === 2) return mem.band;
    return mem.low;
  }

  function evalLadder(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const cutoff = evalNode(node.inputs.cutoff!, state, sampleRate);
    const resonance = evalNode(node.inputs.resonance!, state, sampleRate);
    const mem = getMemory<{
      y1: number;
      y2: number;
      y3: number;
      y4: number;
      kc: number;
      sr: number;
      g: number;
    }>(state, node.i, () => ({ y1: 0, y2: 0, y3: 0, y4: 0, kc: NaN, sr: NaN, g: 0 }));
    if (mem.kc !== cutoff || mem.sr !== sampleRate) {
      const clampedCutoff = Math.min(Math.max(cutoff, 1), sampleRate / 2 - 1);
      mem.g = 1 - Math.exp((-2 * Math.PI * clampedCutoff) / sampleRate);
      mem.kc = cutoff;
      mem.sr = sampleRate;
    }
    const g = mem.g;
    const k = Math.min(Math.max(resonance, 0), 0.99) * 4;
    // Drive is a saturation into the filter, normalised so that 1 is exactly
    // unity. `tanh(x * d) / tanh(d)` is the usual shape but is not the
    // identity at d = 1, so the default is a branch rather than a formula:
    // a ladder that already exists must sound like itself.
    const drive = node.inputs.drive ? evalNode(node.inputs.drive, state, sampleRate) : 1;
    const driven = drive === 1 ? input : Math.tanh(input * drive) / Math.tanh(drive);
    const x = driven - k * Math.tanh(mem.y4);
    mem.y1 += g * (x - mem.y1);
    mem.y2 += g * (mem.y1 - mem.y2);
    mem.y3 += g * (mem.y2 - mem.y3);
    mem.y4 += g * (mem.y3 - mem.y4);
    return mem.y4;
  }

  function evalComb(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const freq = evalNode(node.inputs.freq!, state, sampleRate);
    const feedback = evalNode(node.inputs.feedback!, state, sampleRate);
    const wet = evalNode(node.inputs.mix!, state, sampleRate);
    const mem = getMemory<{ buf: Float32Array; idx: number; pos: number; ready: boolean; c: number; sr: number }>(state, node.i, () => ({
      buf: new Float32Array(Math.max(2, Math.ceil(sampleRate / 20) + 2)),
      idx: 0,
      pos: 0,
      ready: false,
      c: 0,
      sr: NaN,
    }));
    const target = Math.min(Math.max(sampleRate / Math.max(freq, 20), 1), mem.buf.length - 2);
    // Glided, for the same reason as `delay`: this is a delay line whose
    // length is expressed as a frequency, so stepping the frequency teleports
    // the read pointer and clicks. Sweeping a comb is one of the more common
    // things anyone does with one.
    if (mem.sr !== sampleRate) {
      mem.c = 1 - Math.exp(-1 / (0.02 * sampleRate));
      mem.sr = sampleRate;
    }
    if (!mem.ready) {
      mem.pos = target;
      mem.ready = true;
    } else {
      mem.pos += (target - mem.pos) * mem.c;
    }
    const read = mem.idx - mem.pos;
    const i0 = ((Math.floor(read) % mem.buf.length) + mem.buf.length) % mem.buf.length;
    const i1 = (i0 + 1) % mem.buf.length;
    const frac = read - Math.floor(read);
    const delayed = mem.buf[i0]! * (1 - frac) + mem.buf[i1]! * frac;
    mem.buf[mem.idx] = input + delayed * Math.min(Math.max(feedback, -0.99), 0.99);
    mem.idx = (mem.idx + 1) % mem.buf.length;
    const mix = Math.min(Math.max(wet, 0), 1);
    return input * (1 - mix) + delayed * mix;
  }

  function evalBitcrush(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const bits = Math.min(Math.max(evalNode(node.inputs.bits!, state, sampleRate), 1), 16);
    const mem = getMemory<{ k: number; steps: number }>(state, node.i, () => ({ k: NaN, steps: 0 }));
    if (mem.k !== bits) {
      mem.steps = Math.pow(2, bits - 1);
      mem.k = bits;
    }
    const steps = mem.steps;
    return Math.round(input * steps) / steps;
  }

  function evalDownsample(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const factor = Math.max(1, evalNode(node.inputs.factor!, state, sampleRate));
    const mem = getMemory<{ held: number; count: number }>(state, node.i, () => ({ held: 0, count: 0 }));
    if (mem.count <= 0) {
      mem.held = input;
      mem.count = factor;
    }
    mem.count -= 1;
    return mem.held;
  }

  function evalRectify(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    return node.m === 1 ? Math.max(input, 0) : Math.abs(input);
  }

  function evalSlew(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const rise = Math.max(evalNode(node.inputs.rise!, state, sampleRate), 0);
    const fall = Math.max(evalNode(node.inputs.fall!, state, sampleRate), 0);
    const mem = getMemory<{ y: number }>(state, node.i, () => ({ y: input }));
    const delta = input - mem.y;
    if (delta > 0) mem.y += Math.min(delta, rise / sampleRate);
    else mem.y += Math.max(delta, -fall / sampleRate);
    return mem.y;
  }

  /**
   * Sample and hold, on its own rate or on somebody else's clock.
   *
   * A sample and hold whose only rate is its own is half a module: what it is
   * for is taking a reading at the moment the rest of the patch does
   * something, so the held value and the pattern are the same event. There
   * was no inlet for that at all.
   *
   * Both at once would be two grids fighting, so `freq` at zero turns the
   * internal one off. Zero rather than the presence of a cable because the
   * graph cannot see whether a cable is attached: an uncabled jack is still an
   * input node holding its default.
   */
  function evalSampleHold(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const freq = Math.max(evalNode(node.inputs.freq!, state, sampleRate), 0);
    const mem = getMemory<{ held: number; phase: number; prevClock: number }>(state, node.i, () => ({
      held: input,
      phase: 1,
      prevClock: 0,
    }));
    if (node.inputs.clock) {
      const clock = evalNode(node.inputs.clock, state, sampleRate);
      const rose = clock > 0.5 && mem.prevClock <= 0.5;
      mem.prevClock = clock;
      if (rose) mem.held = input;
    }
    if (freq > 0) {
      mem.phase += freq / sampleRate;
      if (mem.phase >= 1) {
        mem.held = input;
        mem.phase -= Math.floor(mem.phase);
      }
    }
    return mem.held;
  }

  function evalCompare(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const threshold = evalNode(node.inputs.threshold!, state, sampleRate);
    if (node.m === 1) return input < threshold ? 1 : 0;
    return input > threshold ? 1 : 0;
  }

  function evalCompressor(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const detect = node.inputs.sidechain ? evalNode(node.inputs.sidechain, state, sampleRate) : input;
    const threshold = Math.max(evalNode(node.inputs.threshold!, state, sampleRate), 1e-6);
    const ratio = Math.max(evalNode(node.inputs.ratio!, state, sampleRate), 1);
    const attack = Math.max(evalNode(node.inputs.attack!, state, sampleRate), 1e-5);
    const release = Math.max(evalNode(node.inputs.release!, state, sampleRate), 1e-5);
    const mem = getMemory<FollowerMemory>(state, node.i, newFollower);
    const target = Math.abs(detect);
    const rising = target > mem.env;
    const coeff = followerCoeff(mem, rising ? attack : release, sampleRate, rising);
    mem.env += (target - mem.env) * coeff;
    if (mem.env <= threshold) return input;
    const gain = Math.pow(threshold / mem.env, 1 - 1 / ratio);
    return input * gain;
  }

  /**
   * Every field is derived from the block snapshot plus `frameIndex`, with no
   * stored state. A transport node asked for the same frame twice answers the
   * same thing, which is what a seam graph's collect and apply passes need.
   */
  function evalTransport(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const snapshot = state.transport ?? DEFAULT_TRANSPORT;
    const field = node.params.field as string;

    if (field === 'bpm') return snapshot.bpm;
    if (field === 'playing') return snapshot.playing ? 1 : 0;
    if (field === 'beatsPerBar') return snapshot.beatsPerBar > 0 ? snapshot.beatsPerBar : 4;
    if (field === 'beatUnit') return normalizeBeatUnit(snapshot.beatUnit);

    if (field === 'division') {
      const table = node.params.divisions as number[];
      if (!table || table.length === 0) return 1;
      const index = Math.round(evalNode(node.inputs.index!, state, sampleRate));
      return table[Math.min(table.length - 1, Math.max(0, index))]!;
    }

    if (field === 'seconds') {
      const length = evalNode(node.inputs.length!, state, sampleRate);
      return snapshot.bpm > 0 ? (length * 60) / snapshot.bpm : 0;
    }

    // A stopped transport holds its position rather than advancing, so a
    // synced LFO sits still under a paused playhead instead of sweeping.
    const perSample = snapshot.playing ? snapshot.bpm / 60 / sampleRate : 0;
    const beats = snapshot.beats + state.frameIndex * perSample;

    if (field === 'beats') return beats;
    if (field === 'bars') {
      const perBar = barBeats(snapshot.beatsPerBar, snapshot.beatUnit);
      return perBar > 0 ? beats / perBar : 0;
    }

    const length = evalNode(node.inputs.length!, state, sampleRate);
    if (!(length > 0)) return 0;

    if (field === 'phase') {
      const turns = beats / length;
      return turns - Math.floor(turns);
    }

    if (field === 'pulse') {
      if (perSample === 0) return 0;
      // A boundary was crossed between the previous sample and this one.
      // Comparing floors rather than testing a wrapped phase against a small
      // window means the pulse lands on exactly one sample at any tempo.
      const previous = beats - perSample;
      return Math.floor(beats / length) !== Math.floor(previous / length) ? 1 : 0;
    }

    return 0;
  }

  /**
   * A rising edge on `reset` puts the node back where it starts.
   *
   * Shared by the five nodes that carry a position in a pattern, because
   * without it a patch cannot start with the song. The transport's `playing`
   * is the signal anybody actually wires here: a clock is a free-running
   * phase and a euclidean is a step counter, so when Play arrives they are
   * wherever they happened to be, and the pattern lands off the bar for as
   * long as the plugin stays loaded. `syncedclock` is exempt, being derived
   * from the song position with no state of its own, but everything counting
   * steps downstream of it is not.
   *
   * Edge-triggered rather than level-triggered, so a `playing` held high is
   * one reset at the top and not a node pinned to step zero for the whole
   * song.
   */
  function resetRose(
    node: PlanNode,
    state: VoiceRuntimeState,
    sampleRate: number,
    mem: { prevReset: number },
  ): boolean {
    if (!node.inputs.reset) return false;
    const value = evalNode(node.inputs.reset, state, sampleRate);
    const rose = value > 0.5 && mem.prevReset <= 0.5;
    mem.prevReset = value;
    return rose;
  }

  function evalClock(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const freq = Math.max(evalNode(node.inputs.freq!, state, sampleRate), 0);
    const mem = getMemory<{ phase: number; prevReset: number }>(state, node.i, () => ({
      phase: 1,
      prevReset: 0,
    }));
    // Phase 1 rather than 0: a clock fires on the sample it is reset, which
    // is what makes Play and the first tick the same instant.
    if (resetRose(node, state, sampleRate, mem)) mem.phase = 1;
    mem.phase += freq / sampleRate;
    if (mem.phase >= 1) {
      mem.phase -= Math.floor(mem.phase);
      return 1;
    }
    return 0;
  }

  function evalClockDivide(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const factor = Math.max(1, Math.round(evalNode(node.inputs.factor!, state, sampleRate)));
    const mem = getMemory<{ prev: number; count: number; prevReset: number }>(state, node.i, () => ({
      prev: 0,
      count: 0,
      prevReset: 0,
    }));
    // One short of the factor, so the next tick through is the one that
    // fires. A divider that swallowed the first `factor` ticks after a reset
    // would start the bar late, which is the thing being fixed.
    if (resetRose(node, state, sampleRate, mem)) mem.count = factor - 1;
    const rose = input > 0.5 && mem.prev <= 0.5;
    mem.prev = input;
    if (!rose) return 0;
    mem.count += 1;
    if (mem.count >= factor) {
      mem.count = 0;
      return 1;
    }
    return 0;
  }

  function evalClockMultiply(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const factor = Math.max(1, Math.round(evalNode(node.inputs.factor!, state, sampleRate)));
    const mem = getMemory<{
      prev: number;
      since: number;
      interval: number;
      nextAt: number;
      left: number;
      armed: boolean;
      prevReset: number;
    }>(state, node.i, () => ({
      prev: 0,
      since: 0,
      interval: 0,
      nextAt: 0,
      left: 0,
      armed: false,
      prevReset: 0,
    }));
    // Back to knowing nothing. The interval is learned from two consecutive
    // input ticks, and one learned before a reset was measured against a
    // position the patch has left.
    if (resetRose(node, state, sampleRate, mem)) {
      mem.since = 0;
      mem.interval = 0;
      mem.nextAt = 0;
      mem.left = 0;
      mem.armed = false;
    }
    const rose = input > 0.5 && mem.prev <= 0.5;
    mem.prev = input;
    if (rose) {
      if (mem.armed && mem.since > 0) {
        mem.interval = mem.since / factor;
        mem.nextAt = 0;
        mem.left = factor;
      }
      mem.since = 0;
      mem.armed = true;
    }
    let out = 0;
    if (mem.left > 0 && mem.since >= mem.nextAt) {
      out = 1;
      mem.nextAt += mem.interval;
      mem.left -= 1;
    }
    mem.since += 1;
    return out;
  }

  function evalLogic(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const mode = node.m;
    const a = evalNode(node.inputs.a!, state, sampleRate) > 0.5;
    if (mode === 3) return a ? 0 : 1;
    const b = evalNode(node.inputs.b!, state, sampleRate) > 0.5;
    if (mode === 1) return a || b ? 1 : 0;
    if (mode === 2) return a !== b ? 1 : 0;
    return a && b ? 1 : 0;
  }

  function evalFlipFlop(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const mem = getMemory<{ prev: number; on: number }>(state, node.i, () => ({ prev: 0, on: 0 }));
    const rose = input > 0.5 && mem.prev <= 0.5;
    mem.prev = input;
    if (rose) mem.on = mem.on > 0.5 ? 0 : 1;
    return mem.on;
  }

  function evalQuantize(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const root = evalNode(node.inputs.root!, state, sampleRate);
    const scale = evalNode(node.inputs.scale!, state, sampleRate);
    return quantizeToScale(input, root, scale);
  }

  function evalEuclidean(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const steps = evalNode(node.inputs.steps!, state, sampleRate);
    const hits = evalNode(node.inputs.hits!, state, sampleRate);
    const rotation = evalNode(node.inputs.rotation!, state, sampleRate);
    const mem = getMemory<{
      prev: number;
      step: number;
      kn: number;
      kh: number;
      kr: number;
      pattern: readonly boolean[] | null;
      prevReset: number;
    }>(state, node.i, () => ({
      prev: 0,
      step: -1,
      kn: NaN,
      kh: NaN,
      kr: NaN,
      pattern: null,
      prevReset: 0,
    }));
    // Before the first step, so the next clock is step zero. The cached
    // pattern is kept: it depends on the three settings and not on where in
    // it the node had got to.
    if (resetRose(node, state, sampleRate, mem)) mem.step = -1;
    const rose = input > 0.5 && mem.prev <= 0.5;
    mem.prev = input;
    if (!rose) return 0;
    const n = Math.max(1, Math.floor(steps));
    mem.step = (mem.step + 1) % n;
    // The pattern only depends on the three settings, so rebuilding it on
    // every hit was allocating on the audio thread for an answer that had
    // not changed since the last bar.
    let pattern = mem.pattern;
    if (!pattern || mem.kn !== n || mem.kh !== hits || mem.kr !== rotation) {
      pattern = euclideanPattern(n, hits, rotation);
      mem.pattern = pattern;
      mem.kn = n;
      mem.kh = hits;
      mem.kr = rotation;
    }
    return pattern[mem.step] ? 1 : 0;
  }

  function evalRandom(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const freq = Math.max(evalNode(node.inputs.freq!, state, sampleRate), 0);
    const mem = getMemory<{ phase: number; prev: number; next: number }>(state, node.i, () => ({
      phase: 1,
      prev: 0,
      next: 0,
    }));
    mem.phase += freq / sampleRate;
    if (mem.phase >= 1) {
      mem.phase -= Math.floor(mem.phase);
      mem.prev = mem.next;
      mem.next = Math.random() * 2 - 1;
    }
    if (node.m === 1) return mem.prev + (mem.next - mem.prev) * mem.phase;
    return mem.next;
  }

  function evalTrigger(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const threshold = evalNode(node.inputs.threshold!, state, sampleRate);
    const mem = getMemory<{ prev: number }>(state, node.i, () => ({ prev: 0 }));
    const rose = input > threshold && mem.prev <= threshold;
    mem.prev = input;
    return rose ? 1 : 0;
  }

  function evalPulse(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const widthSec = Math.max(evalNode(node.inputs.widthSec!, state, sampleRate), 0);
    const mem = getMemory<{ prev: number; left: number }>(state, node.i, () => ({ prev: 0, left: 0 }));
    const rose = input > 0.5 && mem.prev <= 0.5;
    mem.prev = input;
    if (rose) mem.left = Math.max(1, Math.round(widthSec * sampleRate));
    if (mem.left <= 0) return 0;
    mem.left -= 1;
    return 1;
  }

  function evalDahdsr(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const velocity = evalNode(node.inputs.trigger!, state, sampleRate);
    const delay = Math.max(evalNode(node.inputs.delay!, state, sampleRate), 0);
    const attack = Math.max(evalNode(node.inputs.attack!, state, sampleRate), 0);
    const hold = Math.max(evalNode(node.inputs.hold!, state, sampleRate), 0);
    const decay = Math.max(evalNode(node.inputs.decay!, state, sampleRate), 0);
    const sustain = Math.min(Math.max(evalNode(node.inputs.sustain!, state, sampleRate), 0), 1);
    const release = Math.max(evalNode(node.inputs.release!, state, sampleRate), 0);
    const signalGate = node.inputs.gate ? evalNode(node.inputs.gate, state, sampleRate) > 0.5 : false;
    const gated = signalGate || state.gate;
    const mem = getMemory<AdsrMemory>(state, node.i, () => ({
      stage: 'idle',
      level: 0,
      peak: 0,
      stageElapsed: 0,
      stageStartLevel: 0,
      lastGate: false,
    }));

    if (gated && !mem.lastGate) {
      mem.peak = velocity;
      mem.stageElapsed = 0;
      mem.stageStartLevel = mem.level;
      mem.stage = delay > 1e-6 ? 'delay' : 'attack';
    } else if (!gated && mem.lastGate) {
      mem.stage = 'release';
      mem.stageElapsed = 0;
      mem.stageStartLevel = mem.level;
    }
    mem.lastGate = gated;

    const dt = 1 / sampleRate;
    mem.stageElapsed += dt;

    if (mem.stage === 'idle') {
      mem.level = 0;
    } else if (mem.stage === 'delay') {
      mem.level = mem.stageStartLevel;
      if (mem.stageElapsed >= delay) {
        mem.stage = 'attack';
        mem.stageElapsed = 0;
        mem.stageStartLevel = mem.level;
      }
    }
    if (mem.stage === 'attack') {
      const dur = Math.max(attack, 1e-6);
      const t = Math.min(mem.stageElapsed / dur, 1);
      mem.level = mem.stageStartLevel + (mem.peak - mem.stageStartLevel) * t;
      if (t >= 1) {
        mem.stage = hold > 1e-6 ? 'hold' : 'decay';
        mem.stageElapsed = 0;
        mem.stageStartLevel = mem.level;
      }
    }
    if (mem.stage === 'hold') {
      mem.level = mem.peak;
      if (mem.stageElapsed >= hold) {
        mem.stage = 'decay';
        mem.stageElapsed = 0;
        mem.stageStartLevel = mem.level;
      }
    }
    if (mem.stage === 'decay') {
      const target = sustain * mem.peak;
      const dur = Math.max(decay, 1e-6);
      const t = Math.min(mem.stageElapsed / dur, 1);
      mem.level = mem.stageStartLevel + (target - mem.stageStartLevel) * t;
      if (t >= 1) mem.stage = 'sustain';
    }
    if (mem.stage === 'sustain') {
      mem.level = sustain * mem.peak;
    }
    if (mem.stage === 'release') {
      const dur = Math.max(release, 1e-6);
      const t = Math.min(mem.stageElapsed / dur, 1);
      mem.level = mem.stageStartLevel * (1 - t);
      if (t >= 1) {
        mem.stage = 'idle';
        mem.level = 0;
      }
    }

    return mem.level;
  }

  function evalSequencer(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const clockIn = evalNode(node.inputs.clock!, state, sampleRate);
    const steps = node.list ?? [];
    const mem = getMemory<{ prev: number; index: number; prevReset: number }>(state, node.i, () => ({
      prev: 0,
      index: -1,
      prevReset: 0,
    }));
    if (resetRose(node, state, sampleRate, mem)) mem.index = -1;
    const rose = clockIn > 0.5 && mem.prev <= 0.5;
    mem.prev = clockIn;
    if (steps.length === 0) return 0;
    if (rose) mem.index = (mem.index + 1) % steps.length;
    if (mem.index < 0) return 0;
    return evalNode(steps[mem.index]!, state, sampleRate);
  }

  function evalImpulse(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const gated = node.inputs.gate ? evalNode(node.inputs.gate, state, sampleRate) > 0.5 : state.gate;
    const mem = getMemory<{ prev: boolean; armed: boolean }>(state, node.i, () => ({
      prev: false,
      armed: !node.inputs.gate,
    }));
    const rose = gated && !mem.prev;
    mem.prev = gated;
    if (mem.armed || rose) {
      mem.armed = false;
      return 1;
    }
    return 0;
  }

  function evalExpander(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const threshold = Math.max(evalNode(node.inputs.threshold!, state, sampleRate), 1e-6);
    const ratio = Math.max(evalNode(node.inputs.ratio!, state, sampleRate), 1);
    const attack = Math.max(evalNode(node.inputs.attack!, state, sampleRate), 1e-5);
    const release = Math.max(evalNode(node.inputs.release!, state, sampleRate), 1e-5);
    const mem = getMemory<FollowerMemory>(state, node.i, newFollower);
    const target = Math.abs(input);
    const rising = target > mem.env;
    const coeff = followerCoeff(mem, rising ? attack : release, sampleRate, rising);
    mem.env += (target - mem.env) * coeff;
    if (mem.env >= threshold) return input;
    const gain = Math.pow(Math.max(mem.env, 1e-6) / threshold, ratio - 1);
    return input * gain;
  }

  function evalTransient(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const attackAmt = evalNode(node.inputs.attack!, state, sampleRate);
    const sustainAmt = evalNode(node.inputs.sustain!, state, sampleRate);
    const mem = getMemory<{ fast: number; slow: number; sr: number; cf: number; cs: number }>(
      state,
      node.i,
      () => ({ fast: 0, slow: 0, sr: NaN, cf: 0, cs: 0 }),
    );
    // Both coefficients are functions of the sample rate alone: 3 ms and
    // 80 ms are the design, not parameters. Two exponentials per sample for
    // two numbers that never move.
    if (mem.sr !== sampleRate) {
      mem.cf = 1 - Math.exp(-1 / (0.003 * sampleRate));
      mem.cs = 1 - Math.exp(-1 / (0.08 * sampleRate));
      mem.sr = sampleRate;
    }
    const target = Math.abs(input);
    mem.fast += (target - mem.fast) * mem.cf;
    mem.slow += (target - mem.slow) * mem.cs;
    const delta = mem.fast - mem.slow;
    const gain = Math.max(0, 1 + attackAmt * Math.max(delta, 0) * 4 + sustainAmt * mem.slow);
    return input * gain;
  }

  function evalReverse(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const timeSec = Math.max(evalNode(node.inputs.timeSec!, state, sampleRate), 1 / sampleRate);
    const mem = getMemory<{ buf: Float32Array; write: number; read: number }>(state, node.i, () => ({
      buf: new Float32Array(Math.max(2, Math.ceil(Math.max(node.c, 1 / sampleRate) * sampleRate))),
      write: 0,
      read: 0,
    }));
    const span = Math.min(Math.max(Math.round(timeSec * sampleRate), 2), mem.buf.length);
    mem.buf[mem.write % span] = input;
    mem.write += 1;
    mem.read = (mem.read - 1 + span) % span;
    return mem.buf[mem.read] ?? 0;
  }

  function evalLooper(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const box = node.params.box as LooperBox | undefined;
    const field = node.m;
    const takeCap = Math.max(2, Math.ceil(Math.max(node.c, 1 / sampleRate) * sampleRate));
    const ringCap = takeCap + Math.max(2, Math.ceil(0.02 * sampleRate));
    const createMem = (): LooperMem => ({
      ring: new Float32Array(ringCap),
      play: new Float32Array(ringCap),
      undo: null,
      writeAbs: 0,
      startAbs: 0,
      targetLen: 0,
      playLen: 0,
      playRead: 0,
      hasUndo: false,
      recording: false,
      armed: false,
      closing: false,
      prevRec: false,
      prevPlay: true,
      prevClear: false,
      prevOverdub: false,
      prevUndo: false,
    });
    let shared: LooperRuntime | undefined;
    if (box) {
      let byBox = looperRuntimes.get(state);
      if (!byBox) {
        byBox = new WeakMap();
        looperRuntimes.set(state, byBox);
      }
      shared = byBox.get(box);
      if (!shared) {
        shared = { gen: -1, out: 0, start: 0, end: 0, mem: createMem() };
        byBox.set(box, shared);
      }
      if (shared.gen === state.gen) {
        return field === 1 ? shared.start : field === 2 ? shared.end : shared.out;
      }
    }
    const finish = (audio: number, start = 0, end = 0): number => {
      if (shared) {
        shared.gen = state.gen;
        shared.out = audio;
        shared.start = start;
        shared.end = end;
      }
      return field === 1 ? start : field === 2 ? end : audio;
    };
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const rec = evalNode(node.inputs.record!, state, sampleRate) > 0.5;
    const overdub = node.inputs.overdub ? evalNode(node.inputs.overdub, state, sampleRate) > 0.5 : false;
    const undoGate = node.inputs.undo ? evalNode(node.inputs.undo, state, sampleRate) > 0.5 : false;
    const threshold = node.inputs.threshold ? Math.max(0, evalNode(node.inputs.threshold, state, sampleRate)) : 0;
    const quantize = node.inputs.quantize ? Math.round(evalNode(node.inputs.quantize, state, sampleRate)) : 0;
    const fadeSec = node.inputs.fadeSec ? Math.max(0, evalNode(node.inputs.fadeSec, state, sampleRate)) : 0;
    const latencySec = node.inputs.latencySec ? Math.max(0, evalNode(node.inputs.latencySec, state, sampleRate)) : 0;
    const playing = node.inputs.play ? evalNode(node.inputs.play, state, sampleRate) > 0.5 : true;
    const bars = node.inputs.bars ? Math.max(0, evalNode(node.inputs.bars, state, sampleRate)) : 0;
    const durationSec = node.inputs.duration ? evalNode(node.inputs.duration, state, sampleRate) : 0;
    const snapshot = state.transport ?? DEFAULT_TRANSPORT;
    const mem = shared?.mem ?? getMemory<LooperMem>(state, node.i, createMem);
    let durationCap = takeCap;
    if (bars > 0 && snapshot.bpm > 0) {
      const quarter = (sampleRate * 60) / snapshot.bpm;
      durationCap = Math.min(
        takeCap,
        Math.max(2, Math.round(bars * barBeats(snapshot.beatsPerBar, snapshot.beatUnit) * quarter)),
      );
    } else if (durationSec > 0) {
      durationCap = Math.min(
        takeCap,
        Math.max(2, Math.ceil(Math.max(durationSec, 1 / sampleRate) * sampleRate)),
      );
    }
    const fixedLength = bars > 0 || durationSec > 0;
    const cap = mem.ring.length;
    const thisAbs = mem.writeAbs;
    const takeHeld = mem.recording || mem.closing;
    const heldLen = takeHeld ? thisAbs - mem.startAbs : 0;
    const heldCap = mem.closing && mem.targetLen > 0 ? mem.targetLen : durationCap;
    if (!takeHeld || heldLen < heldCap) {
      mem.ring[thisAbs % cap] = input;
    }
    mem.writeAbs += 1;

    const clearing = node.inputs.trigger ? evalNode(node.inputs.trigger, state, sampleRate) > 0.5 : false;
    if (clearing && !mem.prevClear) {
      mem.play.fill(0);
      if (mem.undo) mem.undo.fill(0);
      mem.playLen = 0;
      mem.playRead = 0;
      mem.hasUndo = false;
      mem.recording = false;
      mem.armed = false;
      mem.closing = false;
      mem.targetLen = 0;
    }
    mem.prevClear = clearing;

    if (undoGate && !mem.prevUndo && mem.hasUndo && mem.undo && mem.playLen > 0) {
      mem.play.set(mem.undo.subarray(0, mem.playLen));
      mem.hasUndo = false;
    }
    mem.prevUndo = undoGate;

    const beginRecord = () => {
      const latencyFrames = Math.min(cap - 1, Math.round(latencySec * sampleRate));
      mem.startAbs = thisAbs - latencyFrames;
      if (mem.startAbs < mem.writeAbs - cap) mem.startAbs = mem.writeAbs - cap;
      if (mem.startAbs < 0) mem.startAbs = 0;
      mem.recording = true;
      mem.armed = false;
      mem.closing = false;
      mem.targetLen = 0;
      mem.playLen = 0;
      mem.playRead = 0;
      mem.hasUndo = false;
    };

    if (rec && !mem.prevRec) {
      if (threshold > 0) {
        mem.armed = true;
        mem.recording = false;
        mem.closing = false;
        mem.playLen = 0;
        mem.playRead = 0;
        mem.hasUndo = false;
      } else {
        beginRecord();
      }
    }
    mem.prevRec = rec;

    if (mem.armed && !rec) {
      mem.armed = false;
    }
    if (mem.armed && Math.abs(input) >= threshold) {
      beginRecord();
    }

    const quantizeLen = (raw: number): number => {
      const bounded = Math.min(Math.max(raw, 1), durationCap);
      if (quantize <= 0 || !(snapshot.bpm > 0)) return bounded;
      const quarter = (sampleRate * 60) / snapshot.bpm;
      const beat = quarter * signatureBeatBeats(snapshot.beatUnit);
      const unit = quantize >= 2 ? quarter * barBeats(snapshot.beatsPerBar, snapshot.beatUnit) : beat;
      if (!(unit >= 1)) return bounded;
      const snapped = Math.max(unit, Math.round(bounded / unit) * unit);
      return Math.min(Math.max(1, Math.round(snapped)), durationCap);
    };

    const finalize = (len: number) => {
      const L = Math.min(Math.max(1, Math.round(len)), durationCap, cap);
      for (let i = 0; i < L; i++) {
        mem.play[i] = mem.ring[(mem.startAbs + i) % cap] ?? 0;
      }
      const fadeN = Math.min(Math.round(fadeSec * sampleRate), Math.floor(L / 4));
      if (fadeN > 1 && mem.startAbs >= fadeN) {
        for (let j = 0; j < fadeN; j++) {
          const t = (j + 1) / fadeN;
          const gOut = Math.cos(t * 1.5707963267948966);
          const gIn = Math.sin(t * 1.5707963267948966);
          const pre = mem.ring[(mem.startAbs - fadeN + j) % cap] ?? 0;
          const idx = L - fadeN + j;
          mem.play[idx] = (mem.play[idx] ?? 0) * gOut + pre * gIn;
        }
      }
      mem.playLen = L;
      mem.playRead = 0;
      mem.recording = false;
      mem.armed = false;
      mem.closing = false;
      mem.targetLen = 0;
      mem.hasUndo = false;
    };

    if (playing && !mem.prevPlay) {
      if (mem.armed) {
        mem.armed = false;
      } else if (mem.recording || mem.closing) {
        const rawLen = Math.min(thisAbs - mem.startAbs, durationCap);
        if (rawLen >= 1) {
          const target = quantizeLen(rawLen);
          if (target <= rawLen) {
            finalize(target);
          } else {
            mem.recording = false;
            mem.closing = true;
            mem.targetLen = target;
          }
        }
      } else if (mem.playLen > 0) {
        mem.playRead = 0;
      }
    }
    mem.prevPlay = playing;

    if (mem.armed && rec) {
      return finish(input);
    }

    if (mem.recording && rec) {
      const rawLen = thisAbs - mem.startAbs;
      if ((fixedLength && rawLen >= durationCap) || rawLen >= takeCap) {
        finalize(Math.min(rawLen, durationCap));
      } else {
        return finish(input);
      }
    }

    if (mem.recording && !rec) {
      const rawLen = Math.min(thisAbs - mem.startAbs, durationCap);
      const target = fixedLength && rawLen < durationCap ? durationCap : quantizeLen(rawLen);
      if (target <= rawLen) {
        finalize(target);
      } else {
        mem.recording = false;
        mem.closing = true;
        mem.targetLen = target;
        return finish(input);
      }
    }

    if (mem.closing) {
      if (mem.writeAbs - mem.startAbs >= mem.targetLen) {
        finalize(mem.targetLen);
      } else {
        return finish(input);
      }
    }

    if (overdub && !mem.prevOverdub && mem.playLen > 0) {
      if (!mem.undo || mem.undo.length < mem.playLen) {
        mem.undo = new Float32Array(cap);
      }
      mem.undo.set(mem.play.subarray(0, mem.playLen));
      mem.hasUndo = true;
    }
    mem.prevOverdub = overdub;

    if (mem.playLen <= 0 || !playing) return finish(0);
    if (mem.playRead >= mem.playLen) mem.playRead = 0;
    const atStart = mem.playRead === 0;
    const atEnd = mem.playRead === mem.playLen - 1;
    if (overdub) {
      const mixed = (mem.play[mem.playRead] ?? 0) + input;
      mem.play[mem.playRead] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed;
    }
    const out = mem.play[mem.playRead] ?? 0;
    mem.playRead = (mem.playRead + 1) % mem.playLen;
    return finish(out, atStart ? 1 : 0, atEnd ? 1 : 0);
  }

  function evalSelect(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const a = evalNode(node.inputs.a!, state, sampleRate);
    const b = evalNode(node.inputs.b!, state, sampleRate);
    const which = evalNode(node.inputs.which!, state, sampleRate);
    return which > 0.5 ? b : a;
  }

  function evalWaveshape(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const curve = node.a;
    if (curve.length < 2) return input;
    const t = Math.min(1, Math.max(0, (input + 1) / 2)) * (curve.length - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(curve.length - 1, i0 + 1);
    const frac = t - i0;
    return curve[i0]! * (1 - frac) + curve[i1]! * frac;
  }

  function evalBreakpoints(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const gated = node.inputs.gate ? evalNode(node.inputs.gate, state, sampleRate) > 0.5 : state.gate;
    const mem = getMemory<{ elapsed: number; prev: boolean }>(state, node.i, () => ({ elapsed: 0, prev: false }));
    if (gated && !mem.prev) mem.elapsed = 0;
    mem.prev = gated;
    if (!gated) return 0;
    mem.elapsed += 1 / sampleRate;
    const list = node.list;
    if (list && list.length >= 2) {
      let prevT = evalNode(list[0]!, state, sampleRate);
      let prevL = evalNode(list[1]!, state, sampleRate);
      if (mem.elapsed <= prevT) return prevL;
      for (let i = 2; i + 1 < list.length; i += 2) {
        const t = Math.max(evalNode(list[i]!, state, sampleRate), prevT);
        const level = evalNode(list[i + 1]!, state, sampleRate);
        if (mem.elapsed <= t) {
          const span = Math.max(t - prevT, 1e-9);
          return prevL + (level - prevL) * ((mem.elapsed - prevT) / span);
        }
        prevT = t;
        prevL = level;
      }
      return prevL;
    }
    const times = node.a;
    const levels = node.b;
    if (times.length === 0 || levels.length === 0) return 0;
    if (mem.elapsed <= times[0]!) return levels[0]!;
    for (let i = 1; i < times.length && i < levels.length; i++) {
      if (mem.elapsed <= times[i]!) {
        const span = Math.max(times[i]! - times[i - 1]!, 1e-9);
        const t = (mem.elapsed - times[i - 1]!) / span;
        return levels[i - 1]! + (levels[i]! - levels[i - 1]!) * t;
      }
    }
    return levels[Math.min(levels.length, times.length) - 1]!;
  }

  function evalRms(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const windowSec = Math.max(evalNode(node.inputs.windowSec!, state, sampleRate), 1 / sampleRate);
    const mem = getMemory<{ buf: Float32Array; idx: number; sum: number; filled: number }>(state, node.i, () => ({
      buf: new Float32Array(Math.max(2, Math.round(windowSec * sampleRate))),
      idx: 0,
      sum: 0,
      filled: 0,
    }));
    const sq = input * input;
    mem.sum += sq - mem.buf[mem.idx]!;
    mem.buf[mem.idx] = sq;
    mem.idx = (mem.idx + 1) % mem.buf.length;
    mem.filled = Math.min(mem.filled + 1, mem.buf.length);
    return Math.sqrt(Math.max(mem.sum, 0) / mem.filled);
  }

  function evalPeak(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const release = Math.max(evalNode(node.inputs.release!, state, sampleRate), 1e-5);
    const mem = getMemory<{ peak: number; k: number; sr: number; decay: number }>(state, node.i, () => ({
      peak: 0,
      k: NaN,
      sr: NaN,
      decay: 0,
    }));
    const target = Math.abs(input);
    if (target > mem.peak) mem.peak = target;
    else {
      if (mem.k !== release || mem.sr !== sampleRate) {
        mem.decay = Math.exp(-1 / (release * sampleRate));
        mem.k = release;
        mem.sr = sampleRate;
      }
      mem.peak *= mem.decay;
    }
    return mem.peak;
  }

  function evalOnset(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const threshold = evalNode(node.inputs.threshold!, state, sampleRate);
    const mem = getMemory<{ env: number; prev: number; sr: number; c: number }>(state, node.i, () => ({
      env: 0,
      prev: 0,
      sr: NaN,
      c: 0,
    }));
    if (mem.sr !== sampleRate) {
      mem.c = 1 - Math.exp(-1 / (0.005 * sampleRate));
      mem.sr = sampleRate;
    }
    const target = Math.abs(input);
    mem.env += (target - mem.env) * mem.c;
    const delta = mem.env - mem.prev;
    mem.prev = mem.env;
    return delta > threshold ? 1 : 0;
  }

  function evalPitch(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const field = node.m;
    const mem = getMemory<{
      ring: Float32Array;
      write: number;
      hz: number;
      midi: number;
      cents: number;
      gate: number;
    }>(state, node.i, () => ({
      ring: new Float32Array(1024),
      write: 0,
      hz: 0,
      midi: 0,
      cents: 0,
      gate: 0,
    }));
    const cap = mem.ring.length;
    mem.ring[mem.write % cap] = input;
    mem.write += 1;
    if (mem.write >= cap && mem.write % 512 === 0) {
      let peak = 0;
      let lastSign = 0;
      let first = -1;
      let last = -1;
      let crossings = 0;
      for (let i = 0; i < cap; i++) {
        const sample = mem.ring[(mem.write + i) % cap] ?? 0;
        const mag = sample < 0 ? -sample : sample;
        if (mag > peak) peak = mag;
        const sign = sample > 0 ? 1 : sample < 0 ? -1 : 0;
        if (lastSign < 0 && sign > 0) {
          if (first < 0) first = i;
          last = i;
          crossings += 1;
        }
        if (sign !== 0) lastSign = sign;
      }
      const span = last - first;
      const minPeriod = sampleRate / 2000;
      const maxPeriod = sampleRate / 50;
      if (peak >= 0.01 && crossings >= 2 && span > 0) {
        const period = span / (crossings - 1);
        if (period >= minPeriod && period <= maxPeriod) {
          const hz = sampleRate / period;
          const midi = 69 + 12 * Math.log2(hz / 440);
          mem.hz = hz;
          mem.midi = midi;
          const nearest = Math.round(midi);
          const cents = (midi - nearest) * 100;
          mem.cents = cents === 50 ? -50 : cents;
          mem.gate = 1;
        } else {
          mem.gate = 0;
        }
      } else {
        mem.gate = 0;
      }
    }
    if (field === 1) return mem.midi;
    if (field === 2) return mem.cents;
    if (field === 3) return mem.gate;
    return mem.hz;
  }

  function evalFilterSlope(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const cutoff = evalNode(node.inputs.cutoff!, state, sampleRate);
    const poles = node.c;
    const highpass = node.m === 1;
    const mem = getMemory<{ y: number[]; k: number; sr: number; g: number }>(state, node.i, () => ({
      y: [0, 0, 0, 0],
      k: NaN,
      sr: NaN,
      g: 0,
    }));
    if (mem.k !== cutoff || mem.sr !== sampleRate) {
      const clampedCutoff = Math.min(Math.max(cutoff, 1), sampleRate / 2 - 1);
      mem.g = 1 - Math.exp((-2 * Math.PI * clampedCutoff) / sampleRate);
      mem.k = cutoff;
      mem.sr = sampleRate;
    }
    const g = mem.g;
    let x = input;
    for (let i = 0; i < poles; i++) {
      mem.y[i]! += g * (x - mem.y[i]!);
      x = highpass ? x - mem.y[i]! : mem.y[i]!;
    }
    return x;
  }

  function evalWavetable(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const freq = evalNode(node.inputs.freq!, state, sampleRate);
    const table = node.table;
    const n = table.length;
    if (n === 0) return 0;
    const mem = getMemory<{ phase: number }>(state, node.i, () => ({ phase: 0 }));
    const requested = node.c > 0 ? Math.max(1, Math.round(node.c)) : n;
    const frameSize = n >= requested * 2 ? requested : n;
    const frames = Math.max(1, Math.floor(n / frameSize));
    const lookup = (frame: number): number => {
      const base = frame * frameSize;
      const idx = mem.phase * frameSize;
      const i0 = ((Math.floor(idx) % frameSize) + frameSize) % frameSize;
      const i1 = (i0 + 1) % frameSize;
      const frac = idx - Math.floor(idx);
      return table[base + i0]! * (1 - frac) + table[base + i1]! * frac;
    };
    let out = lookup(0);
    if (frames > 1 && node.inputs.position) {
      const position = Math.min(1, Math.max(0, evalNode(node.inputs.position, state, sampleRate)));
      const f = position * (frames - 1);
      const f0 = Math.floor(f);
      const f1 = Math.min(frames - 1, f0 + 1);
      const frac = f - f0;
      out = lookup(f0) * (1 - frac) + lookup(f1) * frac;
    }
    mem.phase = (mem.phase + freq / sampleRate) % 1;
    return out;
  }

  function evalSamplePlay(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const rate = evalNode(node.inputs.rate!, state, sampleRate);
    const gated = node.inputs.gate ? evalNode(node.inputs.gate, state, sampleRate) > 0.5 : state.gate;
    const box = node.params.box as SampleBox | undefined;
    const table = box?.samples?.length ? box.samples : node.table;
    const srcRate = box?.sampleRate ?? sampleRate;
    const last = table.length - 1;
    const startPos = node.inputs.position
      ? Math.min(1, Math.max(0, evalNode(node.inputs.position, state, sampleRate))) * Math.max(last, 0)
      : 0;
    const looping = node.inputs.length ? evalNode(node.inputs.length, state, sampleRate) > 0.5 : false;
    const pitchSt = node.inputs.pitch ? evalNode(node.inputs.pitch, state, sampleRate) : 0;
    const mem = getMemory<{ pos: number; prev: boolean; playing: boolean }>(state, node.i, () => ({
      pos: 0,
      prev: false,
      playing: false,
    }));
    if (gated && !mem.prev) {
      mem.pos = startPos;
      mem.playing = table.length > 0;
    }
    mem.prev = gated;
    if (!mem.playing || table.length < 2) return 0;
    if (mem.pos >= last) {
      if (looping && last > startPos) {
        const span = last - startPos;
        mem.pos = startPos + ((mem.pos - startPos) % span);
      } else {
        mem.playing = false;
        return 0;
      }
    }
    const i0 = Math.floor(mem.pos);
    const frac = mem.pos - i0;
    const out = table[i0]! * (1 - frac) + table[i0 + 1]! * frac;
    mem.pos += Math.max(rate, 0) * Math.pow(2, pitchSt / 12) * (srcRate / sampleRate);
    return out;
  }

  function evalGrain(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const duration = Math.max(evalNode(node.inputs.duration!, state, sampleRate), 1 / sampleRate);
    const position = evalNode(node.inputs.position!, state, sampleRate);
    const rate = evalNode(node.inputs.rate!, state, sampleRate);
    const trig = evalNode(node.inputs.trigger!, state, sampleRate);
    const table = node.table;
    const mem = getMemory<{
      prev: number;
      grains: { pos: number; i: number; n: number; rate: number }[];
    }>(state, node.i, () => ({ prev: 0, grains: [] }));
    const rose = trig > 0.5 && mem.prev <= 0.5;
    mem.prev = trig;
    if (rose && table.length > 0) {
      const n = Math.max(2, Math.round(duration * sampleRate));
      const start = Math.min(Math.max(position, 0), 1) * Math.max(table.length - 1, 0);
      mem.grains.push({ pos: start, i: 0, n, rate: Math.max(rate, 0) });
      if (mem.grains.length > 8) mem.grains.shift();
    }
    let out = 0;
    for (let g = mem.grains.length - 1; g >= 0; g--) {
      const grain = mem.grains[g]!;
      if (grain.i >= grain.n || table.length === 0) {
        mem.grains.splice(g, 1);
        continue;
      }
      const i0 = Math.floor(grain.pos);
      if (i0 < 0 || i0 >= table.length - 1) {
        mem.grains.splice(g, 1);
        continue;
      }
      const frac = grain.pos - i0;
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * grain.i) / grain.n));
      out += (table[i0]! * (1 - frac) + table[i0 + 1]! * frac) * hann;
      grain.pos += grain.rate;
      grain.i += 1;
    }
    return out;
  }

  function evalPitchShift(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const raw = evalNode(node.inputs.pitch!, state, sampleRate);
    const pitch = node.m === 1 ? Math.pow(2, raw / 12) : Math.max(raw, 0.25);
    const grain = Math.max(32, Math.round(0.04 * sampleRate));
    const mem = getMemory<{ buf: Float32Array; w: number; ph: number }>(state, node.i, () => ({
      buf: new Float32Array(grain * 4),
      w: 0,
      ph: 0,
    }));
    mem.buf[mem.w] = input;
    const readAt = (offset: number): number => {
      const pos = (mem.w - offset + mem.buf.length * 8) % mem.buf.length;
      const i0 = Math.floor(pos);
      const i1 = (i0 + 1) % mem.buf.length;
      const frac = pos - i0;
      return mem.buf[i0]! * (1 - frac) + mem.buf[i1]! * frac;
    };
    const hann = (t: number) => 0.5 * (1 - Math.cos(2 * Math.PI * t));
    const o1 = mem.ph % grain;
    const o2 = (mem.ph + grain / 2) % grain;
    const out = readAt(o1) * hann(o1 / grain) + readAt(o2) * hann(o2 / grain);
    mem.ph = (mem.ph + pitch) % (grain * 2);
    mem.w = (mem.w + 1) % mem.buf.length;
    return out;
  }

  function evalPanLaw(node: PlanNode, state: VoiceRuntimeState, sampleRate: number): number {
    const input = evalNode(node.inputs.input!, state, sampleRate);
    const pan = Math.min(1, Math.max(-1, evalNode(node.inputs.pan!, state, sampleRate)));
    // The gain is a function of the position alone, and the position is a
    // knob. Cached the way every filter here caches its coefficients: a pan
    // that is not moving was otherwise a sine and a cosine per sample, and a
    // kit with a pan on each of sixteen pads paid that thirty-two times over
    // per sample per channel.
    const mem = getMemory<{ k: number; gain: number }>(state, node.i, () => ({ k: NaN, gain: 0 }));
    if (mem.k !== pan) {
      const angle = ((pan + 1) * Math.PI) / 4;
      mem.gain = node.m === 1 ? Math.sin(angle) : Math.cos(angle);
      mem.k = pan;
    }
    return input * mem.gain;
  }

  return {
    sourceSlot: sourceNode ? sourceNode.slot : null,
    seamSlots: seamNodes.map((seam) => seam.slot),
    stereo,
    ports,
    taps,
    blockConstantNodes: plan.blockConstantNodes,

    drainAnalysis(state): AnalysisFrame | null {
      if (taps.length === 0) return null;
      const meters: Record<string, MeterReading> = {};
      if (state.meters) {
        for (const [id, acc] of state.meters) {
          meters[id] = { peak: acc.peak, rms: acc.count > 0 ? Math.sqrt(acc.sumSq / acc.count) : 0 };
          // Reset rather than decay: each frame reports its own interval, and
          // any smoothing a UI wants is a UI decision made with the timing
          // information it has and this does not.
          acc.peak = 0;
          acc.sumSq = 0;
          acc.count = 0;
        }
      }
      const captures: Record<string, Float32Array> = {};
      if (state.captures) {
        for (const [id, buffer] of state.captures) {
          const { samples, write, filled } = buffer;
          // Unrolled oldest-first, so a reader can hand it straight to
          // `fftMagnitude` or `yinPitch` without knowing it was a ring.
          const linear = new Float32Array(filled ? samples.length : write);
          if (filled) {
            linear.set(samples.subarray(write), 0);
            linear.set(samples.subarray(0, write), samples.length - write);
          } else {
            linear.set(samples.subarray(0, write));
          }
          captures[id] = linear;
        }
      }
      return { meters, captures };
    },

    createState(): VoiceRuntimeState {
      return {
        values: new Float64Array(slotCount),
        // Stamps start at 0 and `gen` at 1, so nothing reads as cached before
        // it has been computed once.
        stamps: new Float64Array(slotCount),
        gen: 1,
        blockGen: -1,
        memory: new Array<unknown>(slotCount).fill(undefined),
        params: {},
        gate: false,
        frameIndex: 0,
        lane: 0,
      };
    },

    noteOn(state, params): void {
      state.params = { ...state.params, ...params };
      state.gate = true;
    },

    noteOff(state): void {
      state.gate = false;
    },

    renderSample(state, sampleRate): number {
      state.gen += 1;
      // One sample is its own block here: a caller feeding values one at a
      // time may change a parameter between any two of them.
      state.blockGen -= 1;
      return evalNode(root, state, sampleRate);
    },

    renderBlock(state, sampleRate, out, input, extras): boolean {
      const frames = out.length;
      // Invalidates every block-constant value. Parameters move between
      // blocks and nowhere else, so this is the whole invalidation.
      state.blockGen -= 1;
      if (extras?.transport) state.transport = extras.transport;

      // A source kernel replaces the graph outright. Nothing downstream of it
      // exists (it is the output node), so the ASL tree is never walked.
      if (sourceNode) {
        const processor = state.kernels?.get(sourceNode.slot);
        if (!processor?.processSource) {
          // Nothing bound. An effect engine passes its signal through so a
          // failed load does not mute the track; an instrument is silent.
          if (sourceNode.m === 2 || !input) {
            out.fill(0);
            extras?.outputR?.fill(0);
          } else {
            out.set(input.subarray(0, frames));
            if (extras?.outputR) extras.outputR.set((extras.inputR ?? input).subarray(0, frames));
          }
          return extras?.outputR !== undefined;
        }
        processor.applyParams?.(state.params);
        // A source kernel is handed a block even when nothing is
        // connected, so an effect-shaped one does not have to null-check.
        let source = input;
        if (!source || source.length < frames) {
          if (!state.sourceScratch || state.sourceScratch.length < frames) {
            state.sourceScratch = new Float32Array(frames);
          } else {
            state.sourceScratch.fill(0);
          }
          if (source) state.sourceScratch.set(source);
          source = state.sourceScratch;
        }
        processor.processSource(source, extras?.inputR ?? null, out, extras?.outputR ?? null);
        return extras?.outputR !== undefined;
      }

      // Live audio for this block. `input` is passed positionally because
      // every insert has one; anything else arrives by name.
      //
      // Written into a scratch object held by the state rather than built
      // fresh. The key set is the graph's own port list and never changes, so
      // the object keeps one shape and a block costs no allocation to say
      // what its inputs are. A port with nothing wired is left `undefined`,
      // which reads exactly as an absent key did.
      let portBlocks = state.portScratch;
      if (!portBlocks) {
        portBlocks = {};
        for (const name of portScratchKeys) portBlocks[name] = undefined;
        state.portScratch = portBlocks;
      }
      const given = extras?.ports;
      for (const name of portScratchKeys) portBlocks[name] = given?.[name];
      if (input) {
        let pair = state.inputPair;
        if (!pair) {
          pair = [undefined, undefined];
          state.inputPair = pair;
        }
        pair[0] = input;
        pair[1] = extras?.inputR;
        portBlocks[MAIN_PORT] = pair;
      }
      state.portBlocks = portBlocks;

      // Which seams have a kernel behind them, counted in place. Filtering
      // into a new array would allocate on the audio thread once per block
      // for a graph that usually has no seams at all.
      let boundSeamCount = 0;
      const kernels = state.kernels;
      if (kernels) {
        for (let s = 0; s < seamNodes.length; s++) {
          if (kernels.has(seamNodes[s]!.slot)) boundSeamCount += 1;
        }
      }
      // Only worth writing per sample when a `param` node named `input`
      // exists to read it. `audio.input()` mints a port and takes the block.
      const scalarInput = writesScalarInput && input ? input : undefined;

      // Nothing wired to a right channel anywhere means both passes would
      // see the same samples. Checked per block because a host may connect a
      // stereo source to the same voice later.
      let allInputsMono = mirrorsMonoInput && extras?.inputR === undefined;
      if (allInputsMono && given) {
        for (const name of portScratchKeys) {
          if (given[name]?.[1] !== undefined) {
            allInputsMono = false;
            break;
          }
        }
      }

      if (boundSeamCount === 0) {
        const outR = stereo && !allInputsMono ? extras?.outputR : undefined;
        // No block-rate stage in play: the plain per-sample path, which is
        // also what an unbound seam slot correctly degrades to.
        for (let i = 0; i < frames; i++) {
          state.frameIndex = i;
          state.lane = 0;
          if (scalarInput) state.params.input = scalarInput[i] ?? 0;
          state.gen += 1;
          out[i] = evalNode(root, state, sampleRate);
          if (outR) {
            // A second full pass, with its own node memory (`memoryFor`), is
            // what makes a filter written once a true stereo filter rather
            // than two mono filters.
            state.lane = 1;
            state.gen += 1;
            outR[i] = evalNode(root, state, sampleRate);
          }
        }
        state.lane = 0;
        state.portBlocks = undefined;
        return outR !== undefined;
      }

      let block = state.seamBlock;
      if (!block) {
        block = { phase: 'sample', index: 0, buffers: new Array(slotCount).fill(undefined) };
        state.seamBlock = block;
      }
      for (let s = 0; s < seamNodes.length; s++) {
        const seamNode = seamNodes[s]!;
        if (!kernels?.has(seamNode.slot)) continue;
        const existing = block.buffers[seamNode.i];
        if (!existing || existing.in.length < frames) {
          block.buffers[seamNode.i] = {
            in: new Float32Array(frames),
            out: new Float32Array(frames),
          };
        }
      }

      // Two passes over the same tree, with the seam stubbed out on the way
      // in. Stateful ASL nodes (biquads, oscillators) therefore advance once
      // per frame during collect and read cached values during apply, which
      // is why a stateful node placed *downstream* of a seam would be
      // double-stepped. Keep stateful work on one side of a seam.
      // A seam graph stays mono. A block-rate kernel is stateful across
      // blocks, so calling it once per channel would interleave one reverb's
      // tail between left and right. A kernel that wants both channels takes
      // them itself, through `processSource`.
      block.phase = 'collect';
      for (let i = 0; i < frames; i++) {
        block.index = i;
        state.frameIndex = i;
        if (scalarInput) state.params.input = scalarInput[i] ?? 0;
        state.gen += 1;
        evalNode(root, state, sampleRate);
      }

      for (let s = 0; s < seamNodes.length; s++) {
        const seamNode = seamNodes[s]!;
        const buffers = block.buffers[seamNode.i];
        const processor = kernels?.get(seamNode.slot);
        if (!buffers || !processor) continue;
        const inputBlock = buffers.in.subarray(0, frames);
        const outputBlock = buffers.out.subarray(0, frames);
        processor.applyParams?.(state.params);
        if (processor.processSeam) processor.processSeam(inputBlock, outputBlock);
        else outputBlock.set(inputBlock);
      }

      block.phase = 'apply';
      for (let i = 0; i < frames; i++) {
        block.index = i;
        state.frameIndex = i;
        if (scalarInput) state.params.input = scalarInput[i] ?? 0;
        state.gen += 1;
        out[i] = evalNode(root, state, sampleRate);
      }
      block.phase = 'sample';
      state.portBlocks = undefined;
      return false;
    },
  };
}
