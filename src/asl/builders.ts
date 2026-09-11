import { ASLValue, type ASLValueLike, toNode } from './ASLValue';
import {
  type ClipMode,
  type CompareMode,
  type LogicMode,
  type NoiseColor,
  type OscShape,
  type PanLawChannel,
  type RandomMode,
  type RectifyMode,
  type LooperBox,
  type SampleBox,
  type SlopeMode,
  type SvfMode,
  constNode,
  makeNode,
} from './types';

/**
 * Lifts a plain number into the node graph. Values that are already
 * `ASLValue`s pass through. `note` / `velocity` accessed off an
 * `ASL.node()` builder's input object are already wrapped.
 */
export function uniform(x: ASLValueLike): ASLValue {
  return x instanceof ASLValue ? x : new ASLValue(constNode(x));
}

/**
 * Internal: a named per-voice input, created lazily by the input proxy
 * (graph.ts's `createTrackedInputProxy`). Not `param` (that name is reserved
 * for the public `param.range(...)` AudioMaterial schema builder, graph/param.ts,
 * a different concept the spec happens to also call "param").
 */
export function paramNode(name: string): ASLValue {
  return new ASLValue(makeNode('param', {}, { name }));
}

/** The port every insert AudioMaterial reads without asking for it. */
export const MAIN_PORT = 'input';

/**
 * Live audio arriving from outside the graph.
 *
 * A `param` is one number for a whole block; a port is a number per sample
 * per channel. Until this existed, an ASL graph had exactly one of them
 * (`input`, minted as a param and filled per sample by the renderer), which
 * quietly decided three things: no sidechain, no stereo, no cross-channel
 * anything. Naming ports makes all three ordinary.
 *
 * `audio.input()` follows the channel being rendered, so a filter written
 * once runs independently on left and right. `audio.left()` / `audio.right()`
 * read a fixed side regardless, which is what mid/side, width and channel
 * swap are made of. `audio.lane()` is the channel index itself, for a graph
 * that wants to behave differently per side (auto-pan, ping-pong).
 *
 * A port with nothing connected reads 0, the same way an unconnected input
 * always has.
 */
export const audio = {
  /** This channel's sample of `name`. Defaults to the main insert input. */
  input(name: string = MAIN_PORT): ASLValue {
    return new ASLValue(makeNode('port', {}, { name }));
  },
  /** Left channel of `name`, whichever channel is being rendered. */
  left(name: string = MAIN_PORT): ASLValue {
    return new ASLValue(makeNode('port', {}, { name, channel: 0 }));
  },
  /** Right channel of `name`, falling back to left when the source is mono. */
  right(name: string = MAIN_PORT): ASLValue {
    return new ASLValue(makeNode('port', {}, { name, channel: 1 }));
  },
  /** A second audio input, by convention the one a compressor keys off. */
  sidechain(): ASLValue {
    return new ASLValue(makeNode('port', {}, { name: 'sidechain' }));
  },
  /** 0 while the left channel is being rendered, 1 for the right. */
  lane(): ASLValue {
    return new ASLValue(makeNode('lane', {}, {}));
  },
};

export function osc(opts: {
  freq: ASLValueLike;
  type?: OscShape | ASLValueLike;
  width?: ASLValueLike;
}): ASLValue {
  const type = opts.type ?? 'sine';
  const baked = typeof type === 'string' ? type : 'sine';
  const liveType = typeof type === 'string' ? undefined : toNode(type);
  return new ASLValue(
    makeNode(
      'osc',
      {
        freq: toNode(opts.freq),
        width: toNode(opts.width ?? 0.5),
        ...(liveType ? { type: liveType } : {}),
      },
      { type: baked },
    ),
  );
}

/** Same oscillator core as `osc`, but the convention is control-rate use (typically followed by `.range()`). */
export function lfo(opts: {
  rate: ASLValueLike;
  shape?: OscShape | ASLValueLike;
  width?: ASLValueLike;
}): ASLValue {
  const shape = opts.shape ?? 'sine';
  const baked = typeof shape === 'string' ? shape : 'sine';
  const liveShape = typeof shape === 'string' ? undefined : toNode(shape);
  return new ASLValue(
    makeNode(
      'lfo',
      {
        rate: toNode(opts.rate),
        ...(opts.width !== undefined ? { width: toNode(opts.width) } : {}),
        ...(liveShape ? { type: liveShape } : {}),
      },
      { shape: baked },
    ),
  );
}

export function mix(...sources: ASLValueLike[]): ASLValue {
  return new ASLValue(makeNode('mix', {}, {}, sources.map(toNode)));
}

export const env = {
  /**
   * Untriggered by default (peak velocity 0, produces silence) until
   * `.trigger(velocity)` binds a velocity input; see ASLValue.trigger.
   */
  /**
   * Attack / decay / sustain / release, in seconds, with sustain as a level.
   *
   * Accepts both the terse spelling (`{ a, d, s, r }`) and the spelled-out one
   * (`{ attack, decay, sustain, release }`), because `dahdsr` below uses the
   * long names and having the two envelopes disagree is a trap. It was a
   * silent one: the interpreter reads `params.a` and friends directly, so a
   * long-named call used to emit a node with no `a` at all and render an
   * unbroken stream of NaN. TypeScript caught that; a JavaScript caller got
   * silence and nothing to search for.
   *
   * Unknown keys throw rather than being ignored, which is what turns a typo
   * like `atack` into a stack trace instead of a mystery.
   */
  adsr(
    opts: {
      a?: number;
      d?: number;
      s?: number;
      r?: number;
      attack?: number;
      decay?: number;
      sustain?: number;
      release?: number;
    } = {},
  ): ASLValue {
    const known = ['a', 'd', 's', 'r', 'attack', 'decay', 'sustain', 'release'];
    const unknown = Object.keys(opts).filter((k) => !known.includes(k));
    if (unknown.length > 0) {
      throw new Error(
        `env.adsr: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
          `Expected any of ${known.join(', ')}.`,
      );
    }
    // Defaults match `dahdsr`, so the two envelopes describe the same shape
    // when asked for nothing in particular.
    const pick = (short: number | undefined, long: number | undefined, fallback: number, name: string) => {
      const value = short ?? long ?? fallback;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`env.adsr: ${name} must be a finite number, got ${String(value)}.`);
      }
      return value;
    };
    return new ASLValue(
      makeNode(
        'adsr',
        { trigger: constNode(0) },
        {
          a: pick(opts.a, opts.attack, 0.005, 'attack'),
          d: pick(opts.d, opts.decay, 0.1, 'decay'),
          s: pick(opts.s, opts.sustain, 0.7, 'sustain'),
          r: pick(opts.r, opts.release, 0.2, 'release'),
        },
      ),
    );
  },

  /**
   * Delay / attack / hold / decay / sustain / release. Times are live graph
   * inputs so an AudioMaterial can expose them. Gate defaults to the voice gate;
   * pass `gate` to drive it from a signal instead.
   */
  dahdsr(
    opts: {
      delay?: ASLValueLike;
      attack?: ASLValueLike;
      hold?: ASLValueLike;
      decay?: ASLValueLike;
      sustain?: ASLValueLike;
      release?: ASLValueLike;
      gate?: ASLValueLike;
    } = {},
  ): ASLValue {
    const inputs: Record<string, ReturnType<typeof toNode>> = {
      trigger: constNode(1),
      delay: toNode(opts.delay ?? 0),
      attack: toNode(opts.attack ?? 0.005),
      hold: toNode(opts.hold ?? 0),
      decay: toNode(opts.decay ?? 0.1),
      sustain: toNode(opts.sustain ?? 0.7),
      release: toNode(opts.release ?? 0.2),
    };
    if (opts.gate !== undefined) inputs.gate = toNode(opts.gate);
    return new ASLValue(makeNode('dahdsr', inputs, {}));
  },

  breakpoints(opts: {
    times: Array<number | ASLValueLike>;
    levels: Array<number | ASLValueLike>;
    gate?: ASLValueLike;
  }): ASLValue {
    const inputs: Record<string, ReturnType<typeof toNode>> = {};
    if (opts.gate !== undefined) inputs.gate = toNode(opts.gate);
    const baked =
      opts.times.every((time) => typeof time === 'number') &&
      opts.levels.every((level) => typeof level === 'number');
    if (baked) {
      return new ASLValue(
        makeNode('breakpoints', inputs, {
          times: opts.times as number[],
          levels: opts.levels as number[],
        }),
      );
    }
    const pairs: ReturnType<typeof toNode>[] = [];
    const count = Math.min(opts.times.length, opts.levels.length);
    for (let i = 0; i < count; i++) {
      pairs.push(toNode(opts.times[i]!));
      pairs.push(toNode(opts.levels[i]!));
    }
    return new ASLValue(makeNode('breakpoints', inputs, { times: [0, 1], levels: [0, 1] }, pairs));
  },
};

export const filter = {
  lowpass(input: ASLValueLike, opts: { cutoff: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterLowpass',
        {
          input: toNode(input),
          cutoff: toNode(opts.cutoff),
          q: toNode(opts.q ?? 0.707),
        },
        {},
      ),
    );
  },

  /** A single parametric (peaking/bell) band: boost or cut `gainDb` around `freq`, width set by `q`. */
  peaking(input: ASLValueLike, opts: { freq: ASLValueLike; gainDb: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterPeaking',
        {
          input: toNode(input),
          freq: toNode(opts.freq),
          gainDb: toNode(opts.gainDb),
          q: toNode(opts.q ?? 1),
        },
        {},
      ),
    );
  },

  lowshelf(input: ASLValueLike, opts: { freq: ASLValueLike; gainDb: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterLowShelf',
        {
          input: toNode(input),
          freq: toNode(opts.freq),
          gainDb: toNode(opts.gainDb),
          q: toNode(opts.q ?? 0.707),
        },
        {},
      ),
    );
  },

  highshelf(input: ASLValueLike, opts: { freq: ASLValueLike; gainDb: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterHighShelf',
        {
          input: toNode(input),
          freq: toNode(opts.freq),
          gainDb: toNode(opts.gainDb),
          q: toNode(opts.q ?? 0.707),
        },
        {},
      ),
    );
  },

  highpass(input: ASLValueLike, opts: { cutoff: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterHighpass',
        {
          input: toNode(input),
          cutoff: toNode(opts.cutoff),
          q: toNode(opts.q ?? 0.707),
        },
        {},
      ),
    );
  },

  bandpass(input: ASLValueLike, opts: { cutoff: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterBandpass',
        {
          input: toNode(input),
          cutoff: toNode(opts.cutoff),
          q: toNode(opts.q ?? 1),
        },
        {},
      ),
    );
  },

  notch(input: ASLValueLike, opts: { cutoff: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterNotch',
        {
          input: toNode(input),
          cutoff: toNode(opts.cutoff),
          q: toNode(opts.q ?? 1),
        },
        {},
      ),
    );
  },

  allpass(input: ASLValueLike, opts: { cutoff: ASLValueLike; q?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'filterAllpass',
        {
          input: toNode(input),
          cutoff: toNode(opts.cutoff),
          q: toNode(opts.q ?? 0.707),
        },
        {},
      ),
    );
  },

  onePoleLowpass(input: ASLValueLike, opts: { cutoff: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode('onePoleLowpass', { input: toNode(input), cutoff: toNode(opts.cutoff) }, {}),
    );
  },

  onePoleHighpass(input: ASLValueLike, opts: { cutoff: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode('onePoleHighpass', { input: toNode(input), cutoff: toNode(opts.cutoff) }, {}),
    );
  },

  svf(input: ASLValueLike, opts: { cutoff: ASLValueLike; q?: ASLValueLike; mode?: SvfMode }): ASLValue {
    return new ASLValue(
      makeNode(
        'svf',
        { input: toNode(input), cutoff: toNode(opts.cutoff), q: toNode(opts.q ?? 0.5) },
        { mode: opts.mode ?? 'lowpass' },
      ),
    );
  },

  ladder(input: ASLValueLike, opts: { cutoff: ASLValueLike; resonance?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'ladder',
        { input: toNode(input), cutoff: toNode(opts.cutoff), resonance: toNode(opts.resonance ?? 0) },
        {},
      ),
    );
  },

  comb(input: ASLValueLike, opts: { freq: ASLValueLike; feedback?: ASLValueLike; mix?: ASLValueLike }): ASLValue {
    return new ASLValue(
      makeNode(
        'comb',
        {
          input: toNode(input),
          freq: toNode(opts.freq),
          feedback: toNode(opts.feedback ?? 0.5),
          mix: toNode(opts.mix ?? 0.5),
        },
        {},
      ),
    );
  },

  slope(
    input: ASLValueLike,
    opts: { cutoff: ASLValueLike; poles?: number; mode?: SlopeMode },
  ): ASLValue {
    return new ASLValue(
      makeNode(
        'filterSlope',
        { input: toNode(input), cutoff: toNode(opts.cutoff) },
        { poles: opts.poles ?? 2, mode: opts.mode ?? 'lowpass' },
      ),
    );
  },
};

export function noise(opts: { color?: NoiseColor | ASLValueLike } = {}): ASLValue {
  const color = opts.color ?? 'white';
  const baked = typeof color === 'string' ? color : 'white';
  const live = typeof color === 'string' ? undefined : toNode(color);
  return new ASLValue(makeNode('noise', live ? { color: live } : {}, { color: baked }));
}

/**
 * Fractional delay line. `timeSec` and `feedback` are per-sample so chorus
 * / flanger / vibrato are compositions, not new node kinds. `maxTimeSec` is
 * author-time: it sizes the buffer and cannot be modulated.
 */
export function delay(
  input: ASLValueLike,
  opts: { timeSec: ASLValueLike; feedback?: ASLValueLike; mix?: ASLValueLike; maxTimeSec?: number },
): ASLValue {
  return new ASLValue(
    makeNode(
      'delay',
      {
        input: toNode(input),
        timeSec: toNode(opts.timeSec),
        feedback: toNode(opts.feedback ?? 0),
        mix: toNode(opts.mix ?? 0.5),
      },
      { maxTimeSec: opts.maxTimeSec ?? 2 },
    ),
  );
}

export function clip(input: ASLValueLike, opts: { drive?: ASLValueLike; mode?: ClipMode } = {}): ASLValue {
  return new ASLValue(
    makeNode('clip', { input: toNode(input), drive: toNode(opts.drive ?? 1) }, { mode: opts.mode ?? 'soft' }),
  );
}

export function dcBlock(input: ASLValueLike): ASLValue {
  return new ASLValue(makeNode('dcBlock', { input: toNode(input) }, {}));
}

export function envFollow(
  input: ASLValueLike,
  opts: { attack?: ASLValueLike; release?: ASLValueLike } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'envFollow',
      {
        input: toNode(input),
        attack: toNode(opts.attack ?? 0.01),
        release: toNode(opts.release ?? 0.1),
      },
      {},
    ),
  );
}

export function bitcrush(input: ASLValueLike, opts: { bits?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('bitcrush', { input: toNode(input), bits: toNode(opts.bits ?? 8) }, {}));
}

export function downsample(input: ASLValueLike, opts: { factor?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('downsample', { input: toNode(input), factor: toNode(opts.factor ?? 4) }, {}));
}

export function rectify(input: ASLValueLike, opts: { mode?: RectifyMode } = {}): ASLValue {
  return new ASLValue(makeNode('rectify', { input: toNode(input) }, { mode: opts.mode ?? 'full' }));
}

export function slew(
  input: ASLValueLike,
  opts: { rise?: ASLValueLike; fall?: ASLValueLike } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'slew',
      { input: toNode(input), rise: toNode(opts.rise ?? 10), fall: toNode(opts.fall ?? 10) },
      {},
    ),
  );
}

export function sampleHold(input: ASLValueLike, opts: { freq?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('sampleHold', { input: toNode(input), freq: toNode(opts.freq ?? 20) }, {}));
}

export function compare(
  input: ASLValueLike,
  opts: { threshold?: ASLValueLike; mode?: CompareMode } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'compare',
      { input: toNode(input), threshold: toNode(opts.threshold ?? 0) },
      { mode: opts.mode ?? 'gt' },
    ),
  );
}

export function compressor(
  input: ASLValueLike,
  opts: {
    threshold?: ASLValueLike;
    ratio?: ASLValueLike;
    attack?: ASLValueLike;
    release?: ASLValueLike;
    sidechain?: ASLValueLike;
  } = {},
): ASLValue {
  const inputs: Record<string, ReturnType<typeof toNode>> = {
    input: toNode(input),
    threshold: toNode(opts.threshold ?? 0.5),
    ratio: toNode(opts.ratio ?? 4),
    attack: toNode(opts.attack ?? 0.005),
    release: toNode(opts.release ?? 0.05),
  };
  if (opts.sidechain !== undefined) inputs.sidechain = toNode(opts.sidechain);
  return new ASLValue(makeNode('compressor', inputs, {}));
}

export function clock(opts: { freq?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('clock', { freq: toNode(opts.freq ?? 2) }, {}));
}

export function clockDivide(input: ASLValueLike, opts: { factor?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('clockDivide', { input: toNode(input), factor: toNode(opts.factor ?? 2) }, {}));
}

export function clockMultiply(input: ASLValueLike, opts: { factor?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('clockMultiply', { input: toNode(input), factor: toNode(opts.factor ?? 2) }, {}));
}

export const logic = {
  and(a: ASLValueLike, b: ASLValueLike): ASLValue {
    return new ASLValue(makeNode('logic', { a: toNode(a), b: toNode(b) }, { mode: 'and' satisfies LogicMode }));
  },
  or(a: ASLValueLike, b: ASLValueLike): ASLValue {
    return new ASLValue(makeNode('logic', { a: toNode(a), b: toNode(b) }, { mode: 'or' satisfies LogicMode }));
  },
  xor(a: ASLValueLike, b: ASLValueLike): ASLValue {
    return new ASLValue(makeNode('logic', { a: toNode(a), b: toNode(b) }, { mode: 'xor' satisfies LogicMode }));
  },
  not(a: ASLValueLike): ASLValue {
    return new ASLValue(makeNode('logic', { a: toNode(a) }, { mode: 'not' satisfies LogicMode }));
  },
};

export function flipFlop(input: ASLValueLike): ASLValue {
  return new ASLValue(makeNode('flipFlop', { input: toNode(input) }, {}));
}

export function quantize(
  input: ASLValueLike,
  opts: { root?: ASLValueLike; scale?: ASLValueLike } = {},
): ASLValue {
  return new ASLValue(
    makeNode('quantize', { input: toNode(input), root: toNode(opts.root ?? 0), scale: toNode(opts.scale ?? 0) }, {}),
  );
}

export function euclidean(
  input: ASLValueLike,
  opts: { steps?: ASLValueLike; hits?: ASLValueLike; rotation?: ASLValueLike } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'euclidean',
      {
        input: toNode(input),
        steps: toNode(opts.steps ?? 8),
        hits: toNode(opts.hits ?? 3),
        rotation: toNode(opts.rotation ?? 0),
      },
      {},
    ),
  );
}

export function random(opts: { freq?: ASLValueLike; mode?: RandomMode } = {}): ASLValue {
  return new ASLValue(makeNode('random', { freq: toNode(opts.freq ?? 8) }, { mode: opts.mode ?? 'stepped' }));
}

export function trigger(input: ASLValueLike, opts: { threshold?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('trigger', { input: toNode(input), threshold: toNode(opts.threshold ?? 0.5) }, {}));
}

export function pulse(input: ASLValueLike, opts: { widthSec?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('pulse', { input: toNode(input), widthSec: toNode(opts.widthSec ?? 0.01) }, {}));
}

export function sequencer(clockIn: ASLValueLike, steps: ASLValueLike[]): ASLValue {
  return new ASLValue(makeNode('sequencer', { clock: toNode(clockIn) }, {}, steps.map(toNode)));
}

export function impulse(opts: { gate?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(
    makeNode('impulse', opts.gate === undefined ? {} : { gate: toNode(opts.gate) }, {}),
  );
}

export function expander(
  input: ASLValueLike,
  opts: { threshold?: ASLValueLike; ratio?: ASLValueLike; attack?: ASLValueLike; release?: ASLValueLike } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'expander',
      {
        input: toNode(input),
        threshold: toNode(opts.threshold ?? 0.25),
        ratio: toNode(opts.ratio ?? 2),
        attack: toNode(opts.attack ?? 0.005),
        release: toNode(opts.release ?? 0.05),
      },
      {},
    ),
  );
}

export function transient(
  input: ASLValueLike,
  opts: { attack?: ASLValueLike; sustain?: ASLValueLike } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'transient',
      { input: toNode(input), attack: toNode(opts.attack ?? 0), sustain: toNode(opts.sustain ?? 0) },
      {},
    ),
  );
}

export function reverse(
  input: ASLValueLike,
  opts: { timeSec?: ASLValueLike; maxTimeSec?: number } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'reverse',
      { input: toNode(input), timeSec: toNode(opts.timeSec ?? 0.25) },
      { maxTimeSec: opts.maxTimeSec ?? 2 },
    ),
  );
}

export const LOOPER_FIELDS = ['audio', 'start', 'end'] as const;
export type LooperField = (typeof LOOPER_FIELDS)[number];

export function createLooperBox(): LooperBox {
  return {};
}

export function looper(
  input: ASLValueLike,
  opts: {
    record?: ASLValueLike;
    play?: ASLValueLike;
    overdub?: ASLValueLike;
    undo?: ASLValueLike;
    maxTimeSec?: number;
    duration?: ASLValueLike;
    bars?: ASLValueLike;
    clear?: ASLValueLike;
    threshold?: ASLValueLike;
    quantize?: ASLValueLike;
    fadeSec?: ASLValueLike;
    latencySec?: ASLValueLike;
    box?: LooperBox;
    field?: LooperField;
  } = {},
): ASLValue {
  const inputs: Record<string, ReturnType<typeof toNode>> = {
    input: toNode(input),
    record: toNode(opts.record ?? 0),
  };
  if (opts.play !== undefined) inputs.play = toNode(opts.play);
  if (opts.duration !== undefined) inputs.duration = toNode(opts.duration);
  if (opts.bars !== undefined) inputs.bars = toNode(opts.bars);
  if (opts.clear !== undefined) inputs.trigger = toNode(opts.clear);
  if (opts.overdub !== undefined) inputs.overdub = toNode(opts.overdub);
  if (opts.undo !== undefined) inputs.undo = toNode(opts.undo);
  if (opts.threshold !== undefined) inputs.threshold = toNode(opts.threshold);
  if (opts.quantize !== undefined) inputs.quantize = toNode(opts.quantize);
  if (opts.fadeSec !== undefined) inputs.fadeSec = toNode(opts.fadeSec);
  if (opts.latencySec !== undefined) inputs.latencySec = toNode(opts.latencySec);
  const params: Record<string, unknown> = { maxTimeSec: opts.maxTimeSec ?? 4 };
  if (opts.box) params.box = opts.box;
  if (opts.field && opts.field !== 'audio') params.field = opts.field;
  return new ASLValue(makeNode('looper', inputs, params));
}

export function select(a: ASLValueLike, b: ASLValueLike, opts: { which?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(
    makeNode('select', { a: toNode(a), b: toNode(b), which: toNode(opts.which ?? 0) }, {}),
  );
}

export function waveshape(input: ASLValueLike, opts: { curve?: number[] } = {}): ASLValue {
  return new ASLValue(makeNode('waveshape', { input: toNode(input) }, { curve: opts.curve ?? [-1, 0, 1] }));
}

export function rms(input: ASLValueLike, opts: { windowSec?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('rms', { input: toNode(input), windowSec: toNode(opts.windowSec ?? 0.05) }, {}));
}

export function peak(input: ASLValueLike, opts: { release?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('peak', { input: toNode(input), release: toNode(opts.release ?? 0.3) }, {}));
}

export function onset(input: ASLValueLike, opts: { threshold?: ASLValueLike } = {}): ASLValue {
  return new ASLValue(makeNode('onset', { input: toNode(input), threshold: toNode(opts.threshold ?? 0.05) }, {}));
}

export const PITCH_FIELDS = ['hz', 'midi', 'cents', 'gate'] as const;
export type PitchField = (typeof PITCH_FIELDS)[number];

export function pitch(
  input: ASLValueLike,
  opts: { field?: PitchField } = {},
): ASLValue {
  return new ASLValue(makeNode('pitch', { input: toNode(input) }, { field: opts.field ?? 'midi' }));
}

export function wavetable(
  opts: {
    freq: ASLValueLike;
    box?: SampleBox;
    table?: Float32Array | number[];
    position?: ASLValueLike;
    frameSize?: number;
  },
): ASLValue {
  const inputs: Record<string, ReturnType<typeof toNode>> = { freq: toNode(opts.freq) };
  if (opts.position !== undefined) inputs.position = toNode(opts.position);
  return new ASLValue(
    makeNode(
      'wavetable',
      inputs,
      {
        box: opts.box,
        table: opts.table ?? opts.box?.samples,
        ...(opts.frameSize !== undefined ? { frameSize: opts.frameSize } : {}),
      },
    ),
  );
}

export function samplePlay(
  opts: {
    rate?: ASLValueLike;
    gate?: ASLValueLike;
    position?: ASLValueLike;
    loop?: ASLValueLike;
    pitch?: ASLValueLike;
    box?: SampleBox;
    table?: Float32Array;
  } = {},
): ASLValue {
  const inputs: Record<string, ReturnType<typeof toNode>> = { rate: toNode(opts.rate ?? 1) };
  if (opts.gate !== undefined) inputs.gate = toNode(opts.gate);
  if (opts.position !== undefined) inputs.position = toNode(opts.position);
  if (opts.loop !== undefined) inputs.length = toNode(opts.loop);
  if (opts.pitch !== undefined) inputs.pitch = toNode(opts.pitch);
  return new ASLValue(makeNode('samplePlay', inputs, { box: opts.box, table: opts.table ?? opts.box?.samples }));
}

export function grain(
  triggerIn: ASLValueLike,
  opts: {
    duration?: ASLValueLike;
    position?: ASLValueLike;
    rate?: ASLValueLike;
    box?: SampleBox;
    table?: Float32Array;
  } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'grain',
      {
        trigger: toNode(triggerIn),
        duration: toNode(opts.duration ?? 0.04),
        position: toNode(opts.position ?? 0),
        rate: toNode(opts.rate ?? 1),
      },
      { box: opts.box, table: opts.table ?? opts.box?.samples },
    ),
  );
}

export function pitchShift(
  input: ASLValueLike,
  opts: { pitch?: ASLValueLike; unit?: 'ratio' | 'st' } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'pitchShift',
      { input: toNode(input), pitch: toNode(opts.pitch ?? 1) },
      opts.unit === 'st' ? { unit: 'st' } : {},
    ),
  );
}

export function panLaw(
  input: ASLValueLike,
  opts: { pan?: ASLValueLike; channel?: PanLawChannel } = {},
): ASLValue {
  return new ASLValue(
    makeNode(
      'panLaw',
      { input: toNode(input), pan: toNode(opts.pan ?? 0) },
      { channel: opts.channel ?? 'left' },
    ),
  );
}

/**
 * Names a block-rate DSP unit the host binds later (`renderers/kernel.ts`).
 *
 * This is crate's answer to "how does someone add DSP that isn't ASL math"
 * without that DSP living in crate. The graph carries only a slot name, so
 * it stays plain serializable data; whether anything is bound to that name,
 * and what it does, is entirely the host's business. An unbound slot is a
 * passthrough, never silence.
 */
export const kernel = {
  /**
   * A block-rate stage *inside* an ASL graph. Upstream nodes are collected
   * into a block, the bound kernel transforms it, downstream nodes read the
   * result. Use this when the surrounding math is still per-sample ASL
   * (an amp's tone stack and output gain around neural inference).
   */
  seam(slot: string, input: ASLValueLike): ASLValue {
    return new ASLValue(makeNode('kernel', { input: toNode(input) }, { slot, mode: 'seam' }));
  },

  /**
   * A kernel that *is* the whole graph: it fills the output block itself and
   * the ASL tree is not evaluated at all. Use this for an engine that owns
   * its own voice allocation or internal routing (a granular engine, a
   * polyphonic synth). `input` is optional because an instrument ignores it.
   *
   * Must be the graph's output node to take effect; a source kernel buried
   * mid-graph has no per-sample meaning and evaluates to 0.
   *
   * `fallback` is what happens when nothing is bound to the slot, and the
   * right answer differs by role. An *effect* engine should pass its input
   * through, so an insert whose WASM never loaded stays audible instead of
   * muting the track. An *instrument* should be silent: it has no
   * input to pass. Default is `passthrough`.
   */
  source(
    slot: string,
    input?: ASLValueLike,
    opts?: { fallback?: 'passthrough' | 'silence' },
  ): ASLValue {
    return new ASLValue(
      makeNode(
        'kernel',
        input === undefined ? {} : { input: toNode(input) },
        { slot, mode: 'source', fallback: opts?.fallback ?? 'passthrough' },
      ),
    );
  },
};
