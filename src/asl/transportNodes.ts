import { ASLValue, type ASLValueLike } from './ASLValue';
import { constNode, makeNode, type ASLNode } from './types';

/**
 * The host's musical position, inside a graph.
 *
 * Everything else in ASL is a pure function of its inputs and its own state.
 * A transport node is a function of what the song is doing, which makes it
 * the one place a graph reads the outside world. That is exactly why a
 * tempo-synced delay could not be written before this existed: the graph had
 * no way to ask what the tempo was.
 *
 * The position is **phase-locked to the timeline, not free-running**. Starting
 * playback at bar 5 gives the same synced LFO phase as playing through to bar
 * 5. A free-running oscillator cannot do that.
 */

function toNode(value: ASLValueLike): ASLNode {
  return value instanceof ASLValue ? value.node : constNode(value);
}

/**
 * Note lengths in beats, where one beat is a quarter note. Dotted is one and
 * a half, a triplet is two thirds.
 *
 * Exported because an AudioMaterial's division menu and the table its graph looks
 * up have to agree, and the way to guarantee that is for both to come from
 * here rather than from two hand-typed lists.
 */
export const SYNC_DIVISIONS = {
  '4/1': 16,
  '2/1': 8,
  '1/1': 4,
  '1/2': 2,
  '1/2.': 3,
  '1/2T': 4 / 3,
  '1/4': 1,
  '1/4.': 1.5,
  '1/4T': 2 / 3,
  '1/8': 0.5,
  '1/8.': 0.75,
  '1/8T': 1 / 3,
  '1/16': 0.25,
  '1/16.': 0.375,
  '1/16T': 1 / 6,
  '1/32': 0.125,
} as const;

export type SyncDivision = keyof typeof SYNC_DIVISIONS;

/** The names in `SYNC_DIVISIONS` order: what a division menu shows. */
export const SYNC_DIVISION_NAMES = Object.keys(SYNC_DIVISIONS) as SyncDivision[];

/** The beat lengths in the same order: what `transport.division` looks up. */
export const SYNC_DIVISION_BEATS = SYNC_DIVISION_NAMES.map((name) => SYNC_DIVISIONS[name]);

/**
 * The musically useful subset, for a menu that should not be sixteen items
 * long. Straight, dotted and triplet eighths and quarters cover most of what
 * a delay or an LFO is ever set to.
 */
export const COMMON_DIVISION_NAMES = [
  '1/1',
  '1/2',
  '1/2.',
  '1/4',
  '1/4.',
  '1/4T',
  '1/8',
  '1/8.',
  '1/8T',
  '1/16',
  '1/16T',
] as const satisfies readonly SyncDivision[];

export const COMMON_DIVISION_BEATS = COMMON_DIVISION_NAMES.map((name) => SYNC_DIVISIONS[name]);

export function divisionBeats(name: SyncDivision): number {
  return SYNC_DIVISIONS[name];
}

/**
 * The lower number of a time signature. Absent or non-positive means 4:
 * a beat is a quarter note, which is every existing 4/4 and 3/4 project.
 */
export function normalizeBeatUnit(beatUnit: number | undefined): number {
  return beatUnit && beatUnit > 0 ? beatUnit : 4;
}

/**
 * How many quarter-note beats one signature beat lasts.
 * 4/4 is 1, 6/8 is 1/2, 2/2 is 2.
 */
export function signatureBeatBeats(beatUnit?: number): number {
  return 4 / normalizeBeatUnit(beatUnit);
}

/**
 * Quarter-note beats in one bar. 4/4 is 4, 6/8 is 3, 2/2 is 4.
 */
export function barBeats(beatsPerBar?: number, beatUnit?: number): number {
  const perBar = beatsPerBar && beatsPerBar > 0 ? beatsPerBar : 4;
  return perBar * signatureBeatBeats(beatUnit);
}

function transportNode(
  field: string,
  inputs: Record<string, ASLNode> = {},
  params: Record<string, unknown> = {},
): ASLValue {
  return new ASLValue(makeNode('transport', inputs, { field, ...params }));
}

export const transport = {
  /** Position in beats since the timeline origin, fractional and monotonic while rolling. */
  beats(): ASLValue {
    return transportNode('beats');
  },

  /** Position in bars, using the host's time signature. */
  bars(): ASLValue {
    return transportNode('bars');
  },

  /** Tempo, as a value a graph can compute with. */
  bpm(): ASLValue {
    return transportNode('bpm');
  },

  /** The time-signature numerator. */
  beatsPerBar(): ASLValue {
    return transportNode('beatsPerBar');
  },

  /** The time-signature denominator: 4 is a quarter, 8 is an eighth. */
  beatUnit(): ASLValue {
    return transportNode('beatUnit');
  },

  /**
   * 1 while rolling, 0 when stopped. Useful for gating a synced effect so it
   * does not tick along under a stopped transport.
   */
  playing(): ASLValue {
    return transportNode('playing');
  },

  /**
   * A 0..1 ramp within each division: a grid-locked LFO. Multiply, offset or
   * shape it into whatever motion you want.
   */
  phase(length: ASLValueLike = 1): ASLValue {
    return transportNode('phase', { length: toNode(length) });
  },

  /**
   * 1 for a single sample at each division boundary: a grid-locked clock,
   * which is the input every sequencer node here already takes.
   */
  pulse(length: ASLValueLike = 1): ASLValue {
    return transportNode('pulse', { length: toNode(length) });
  },

  /**
   * A division's length in seconds at the current tempo. This is what a
   * synced delay wants: `delay(input, { timeSec: transport.seconds(0.75) })`
   * is a dotted eighth that follows a tempo change.
   */
  seconds(length: ASLValueLike = 1): ASLValue {
    return transportNode('seconds', { length: toNode(length) });
  },

  /**
   * Looks a live index up in a baked table and returns that many beats,
   * which is how an `enum` parameter reaches a graph. The index is a param,
   * so it automates and it maps onto a plugin parameter tree like anything
   * else; the table is data, so the mapping does not have to be repeated in
   * a switch statement on the audio thread.
   *
   * Out-of-range indices clamp to the ends, because a menu that grows in a
   * later version must not read past its own table on an old project.
   */
  division(index: ASLValueLike, opts: { divisions?: readonly number[] } = {}): ASLValue {
    return transportNode(
      'division',
      { index: toNode(index) },
      { divisions: [...(opts.divisions ?? COMMON_DIVISION_BEATS)] },
    );
  },
};

/**
 * What a renderer hands the evaluator each block. An anchor, not a stream:
 * the host publishes this when something changes and both realms derive the
 * position from the audio clock, so nothing is posted per block and the two
 * cannot drift apart.
 */
export interface TransportSnapshot {
  /** Beats at the start of the current block. Quarter-note beats. */
  readonly beats: number;
  readonly bpm: number;
  readonly playing: boolean;
  /** Time-signature numerator. */
  readonly beatsPerBar: number;
  /**
   * Time-signature denominator. 4 is a quarter-note beat, 8 is an eighth.
   * Absent means 4, so every snapshot written before this field existed
   * still means what it meant.
   */
  readonly beatUnit?: number;
}

export const DEFAULT_TRANSPORT: TransportSnapshot = {
  beats: 0,
  bpm: 120,
  playing: false,
  beatsPerBar: 4,
  beatUnit: 4,
};

/**
 * The anchor a host publishes: a musical position pinned to a moment on the
 * audio clock. A renderer turns it into a per-block `TransportSnapshot`.
 */
export interface TransportAnchor {
  /** Audio-clock time this position was true at. */
  readonly atTime: number;
  readonly beats: number;
  readonly bpm: number;
  readonly playing: boolean;
  readonly beatsPerBar: number;
  readonly beatUnit?: number;
  /**
   * Tempo's rate of change from this anchor, in BPM per beat, for a playhead
   * that starts or seeks into the middle of a ramp. Absent or zero means the
   * tempo holds until the first entry in `changes`, which is the case for
   * every map without ramps.
   */
  readonly slope?: number;
  /**
   * Tempo changes still ahead, already converted to audio-clock time by
   * whoever published this.
   *
   * The audio thread does no musical arithmetic to follow one: it picks the
   * last entry that has arrived and derives from that, which is the same
   * derivation it does from the anchor itself. The conversion happens once,
   * on the main thread, where the tempo map lives.
   *
   * Absent, which is the default, means the tempo does not change and the
   * derivation is exactly what it was before tempo maps existed.
   */
  readonly changes?: readonly TransportSegment[];
}

/** One tempo span, pinned to the audio clock. */
export interface TransportSegment {
  readonly atTime: number;
  readonly beats: number;
  readonly bpm: number;
  /**
   * Tempo's rate of change across this span, in BPM per beat. Absent or zero
   * means the span holds, which is every span of a map with no ramps and
   * every constant span of one that has them.
   *
   * A ramp is carried as its two numbers rather than approximated as a
   * staircase of small constant spans. It costs one logarithm per block and
   * it is exact, where a staircase would be a pile of messages that is still
   * wrong in between its steps.
   */
  readonly slope?: number;
}

export const DEFAULT_TRANSPORT_ANCHOR: TransportAnchor = {
  atTime: 0,
  beats: 0,
  bpm: 120,
  playing: false,
  beatsPerBar: 4,
  beatUnit: 4,
};

/**
 * Position at `time`, derived from the anchor. A stopped transport holds its
 * position rather than advancing, which is what makes a synced LFO sit still
 * under a paused playhead instead of sweeping through it.
 */
export function transportAt(anchor: TransportAnchor, time: number): TransportSnapshot {
  // The latest tempo change that has already happened, or the anchor itself.
  // A stopped transport never advances past its anchor, so it never crosses
  // one either: pausing on a tempo change must not step over it.
  let from: TransportSegment = anchor;
  if (anchor.playing && anchor.changes) {
    for (const segment of anchor.changes) {
      if (segment.atTime <= time) from = segment;
      else break;
    }
  }
  const elapsed = anchor.playing ? Math.max(0, time - from.atTime) : 0;
  const slope = from.slope ?? 0;
  if (slope === 0) {
    // The path every span without a ramp takes, unchanged.
    return {
      beats: from.beats + (elapsed * from.bpm) / 60,
      bpm: from.bpm,
      playing: anchor.playing,
      beatsPerBar: anchor.beatsPerBar,
      beatUnit: normalizeBeatUnit(anchor.beatUnit),
    };
  }
  // Tempo moving linearly with the beat: `v = v0 * exp(k*t/60)`, and beats
  // are how far that has carried us. The same integral the tempo map does on
  // the main thread, so the two realms agree to the sample rather than
  // drifting apart across a long accelerando.
  const bpm = from.bpm * Math.exp((slope * elapsed) / 60);
  return {
    beats: from.beats + (bpm - from.bpm) / slope,
    bpm,
    playing: anchor.playing,
    beatsPerBar: anchor.beatsPerBar,
    beatUnit: normalizeBeatUnit(anchor.beatUnit),
  };
}

/**
 * The snapshot advanced by `samples` frames. Used where one block is rendered
 * in several ranges: each range starts where the previous one ended, and a
 * stopped transport advances by nothing.
 */
export function advanceTransport(
  snapshot: TransportSnapshot,
  samples: number,
  sampleRate: number,
): TransportSnapshot {
  if (samples === 0 || !snapshot.playing || sampleRate <= 0) return snapshot;
  return { ...snapshot, beats: snapshot.beats + (samples * snapshot.bpm) / 60 / sampleRate };
}
