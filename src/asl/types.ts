/**
 * A graph is data, not a running process. Every ASL builder function
 * (osc, env.adsr, filter.lowpass, ...) produces one of
 * these plain, serializable node objects rather than starting any audio
 * processing itself; a renderer (WebAudioRenderer, OfflineRenderer, ...)
 * decides later how the same graph actually runs.
 *
 * Every node kind, as data.
 *
 * An array rather than a bare union because the union does not survive to
 * runtime, and three things need to enumerate the kinds while the program is
 * running: the conformance-coverage test (does every kind have a golden
 * case), the fixture emitter (which kinds is a second implementation being
 * held to), and the Swift interpreter's own parity check. Each of those was
 * previously a hand-maintained list, which meant three lists that could drift
 * from this one and from each other. `NodeKind` is derived from this array,
 * so a kind added here is a kind the type accepts and a kind the gate demands
 * evidence for, in one edit.
 *
 * Order is meaningless. Nothing may index into this.
 */
export const ALL_NODE_KINDS = [
  'const',
  'param',
  /**
   * A named live audio input (`asl/ports.ts`). `params.name` is the port,
   * `params.channel` is `undefined` to follow the channel being rendered or
   * a fixed index to read one side regardless. This is what separates a
   * signal that arrives per sample from a `param`, which is one number for
   * the whole block, and it is what makes a second audio input (a sidechain,
   * a stereo partner) expressible in a graph at all.
   */
  'port',
  /** Which output channel the evaluator is currently on: 0 left, 1 right. */
  'lane',
  /**
   * Passthrough taps that record what went by (`asl/analysis.ts`). `meter`
   * keeps peak and RMS for the interval; `capture` keeps the last N samples
   * so the main thread can run a spectrum, a pitch detector or a loudness
   * meter on them. Neither changes the signal.
   */
  'meter',
  'capture',
  'osc',
  'lfo',
  'adsr',
  'mix',
  'mul',
  'add',
  'toFrequency',
  'range',
  'filterLowpass',
  'filterHighpass',
  'filterBandpass',
  'filterNotch',
  'filterPeaking',
  'filterLowShelf',
  'filterHighShelf',
  'filterAllpass',
  'onePoleLowpass',
  'onePoleHighpass',
  'svf',
  'ladder',
  'comb',
  'bitcrush',
  'downsample',
  'rectify',
  'slew',
  'sampleHold',
  'compare',
  'compressor',
  'clock',
  'clockDivide',
  'clockMultiply',
  'logic',
  'flipFlop',
  'quantize',
  'euclidean',
  'random',
  'trigger',
  'pulse',
  'dahdsr',
  'sequencer',
  'impulse',
  'expander',
  'transient',
  'reverse',
  'looper',
  'select',
  'waveshape',
  'breakpoints',
  'rms',
  'peak',
  'onset',
  'pitch',
  'filterSlope',
  'wavetable',
  'samplePlay',
  'grain',
  'pitchShift',
  'panLaw',
  'noise',
  'delay',
  'clip',
  'dcBlock',
  'envFollow',
  /**
   * A named block-rate escape hatch (`renderers/kernel.ts`). `params.slot`
   * names the binding and `params.mode` is `'seam'` or `'source'`. The node
   * kind is generic on purpose: crate core has no `neuralNam`, no `grain`,
   * no `convolver` node, because a graph that names a specific engine is a
   * graph only that engine's author can extend.
   */
  'kernel',
  /**
   * The host's musical position, read live. One kind with a `field` option
   * rather than seven kinds, because they all read the same per-block
   * snapshot and differ only in what they do with it.
   *
   * These are the one class of node whose value comes from outside both the
   * graph and the audio it is processing. Everything else in ASL is a pure
   * function of its inputs and its own state; a transport node is a function
   * of what the song is doing.
   */
  'transport',
] as const;

export type NodeKind = (typeof ALL_NODE_KINDS)[number];

/**
 * The fields a `transport` node can read, as data, for the same reason
 * `ALL_NODE_KINDS` is an array: a second dimension the coverage gate has to
 * be able to walk. One `transport` case in the fixture would prove almost
 * nothing, since the eight fields share only their snapshot.
 */
export const ALL_TRANSPORT_FIELDS = [
  /** Position in beats since the timeline origin. Fractional, monotonic while rolling. */
  'beats',
  /** Position in bars, using the snapshot's time signature. */
  'bars',
  /** Tempo. */
  'bpm',
  /** 1 while the transport is rolling, 0 when it is not. */
  'playing',
  /** 0..1 within a division of `length` beats. A grid-locked ramp. */
  'phase',
  /** 1 for a single sample at each `length`-beat boundary. A grid-locked clock. */
  'pulse',
  /** `length` beats expressed in seconds at the current tempo. A synced delay time. */
  'seconds',
  /** Looks `index` up in a baked division table and returns that many beats. */
  'division',
  /** Time-signature numerator. */
  'beatsPerBar',
  /** Time-signature denominator. 4 is a quarter, 8 is an eighth. */
  'beatUnit',
] as const;

export type TransportField = (typeof ALL_TRANSPORT_FIELDS)[number];

export type OscShape =
  | 'sine'
  | 'saw'
  | 'square'
  | 'triangle'
  | 'pulse'
  | 'varshape'
  | 'supersquare'
  | 'harmonic';
export type NoiseColor = 'white' | 'pink' | 'brown' | 'blue' | 'violet' | 'grey';
export type ClipMode = 'soft' | 'hard';
export type RectifyMode = 'full' | 'half';
export type SvfMode = 'lowpass' | 'highpass' | 'bandpass';
export type CompareMode = 'gt' | 'lt';
export type LogicMode = 'and' | 'or' | 'xor' | 'not';
export type RandomMode = 'stepped' | 'smooth';
export type SlopeMode = 'lowpass' | 'highpass';
export type PanLawChannel = 'left' | 'right';

/** Shared audio buffer a sample / wavetable / grain node reads at render time. */
export interface SampleBox {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Identity token so audio, start, and end field-reads in one graph share
 * one kernel. Runtime state stays on the voice, not on this object.
 */
export interface LooperBox {
  readonly _looper?: true;
}

export interface ASLNode {
  readonly id: number;
  readonly kind: NodeKind;
  /** Named node-typed inputs, e.g. `osc`'s `freq` or `filterLowpass`'s `input`/`cutoff`/`q`. */
  readonly inputs: Readonly<Record<string, ASLNode>>;
  /** Variable-length node-typed input, used only by `mix`. */
  readonly list?: readonly ASLNode[];
  /** Non-modulatable configuration: oscillator `type`, ADSR `a`/`d`/`s`/`r`, `range`'s `min`/`max`. */
  readonly params: Readonly<Record<string, unknown>>;
}

let nextNodeId = 1;

export function makeNode(
  kind: NodeKind,
  inputs: Record<string, ASLNode>,
  params: Record<string, unknown>,
  list?: readonly ASLNode[],
): ASLNode {
  return { id: nextNodeId++, kind, inputs, params, list };
}

export function constNode(value: number): ASLNode {
  return makeNode('const', {}, { value });
}
