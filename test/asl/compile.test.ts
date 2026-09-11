import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { compileVoice } from '../../src/asl/compile';
import {
  osc,
  lfo,
  mix,
  env,
  filter,
  kernel,
  uniform,
  noise,
  delay,
  clip,
  dcBlock,
  envFollow,
  bitcrush,
  downsample,
  rectify,
  slew,
  sampleHold,
  compare,
  compressor,
  clock,
  clockDivide,
  clockMultiply,
  logic,
  flipFlop,
  quantize,
  euclidean,
  random,
  trigger,
  pulse,
  sequencer,
  impulse,
  expander,
  transient,
  reverse,
  looper,
  createLooperBox,
  select,
  waveshape,
  rms,
  peak,
  onset,
  pitch,
  wavetable,
  samplePlay,
  grain,
  pitchShift,
  panLaw,
} from '../../src/asl/builders';
import { euclideanPattern, quantizeToScale } from '../../src/asl/controlMath';

const SR = 48000;

describe('oscillators', () => {
  it('sine matches Math.sin at each sample given the same phase accumulation', () => {
    const graph = ASL.node(() => osc({ freq: uniform(440), type: 'sine' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});

    let expectedPhase = 0;
    for (let i = 0; i < 100; i++) {
      const sample = voice.renderSample(state, SR);
      expect(sample).toBeCloseTo(Math.sin(2 * Math.PI * expectedPhase), 10);
      expectedPhase = (expectedPhase + 440 / SR) % 1;
    }
  });

  it('saw ramps linearly from -1 toward 1 across one period', () => {
    const graph = ASL.node(() => osc({ freq: uniform(100), type: 'saw' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});

    const first = voice.renderSample(state, SR);
    expect(first).toBeCloseTo(-1, 5);

    const periodSamples = Math.round(SR / 100);
    let last = first;
    for (let i = 1; i < periodSamples; i++) {
      const sample = voice.renderSample(state, SR);
      expect(sample).toBeGreaterThan(last);
      last = sample;
    }
  });

  it('square is bipolar and flips once per period, evenly', () => {
    const graph = ASL.node(() => osc({ freq: uniform(1000), type: 'square' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});

    const periodSamples = SR / 1000; // 48, exact
    const samples: number[] = [];
    for (let i = 0; i < periodSamples; i++) {
      samples.push(voice.renderSample(state, SR));
    }

    expect(samples.every((s) => s === 1 || s === -1)).toBe(true);
    // starts high, flips low exactly once, never flips back within one period
    // (accumulated phase can drift by a sample either side of exact center, so
    // allow the flip index to land at 24 +/- 1 rather than pinning it exactly)
    const flipIndex = samples.findIndex((s) => s === -1);
    expect(flipIndex).toBeGreaterThanOrEqual(periodSamples / 2 - 1);
    expect(flipIndex).toBeLessThanOrEqual(periodSamples / 2 + 1);
    expect(samples.slice(flipIndex).every((s) => s === -1)).toBe(true);
  });

  it('varshape morphs from triangle through saw toward square', () => {
    const tri = ASL.node(() => osc({ freq: uniform(400), type: 'varshape', width: uniform(0) }));
    const saw = ASL.node(() => osc({ freq: uniform(400), type: 'varshape', width: uniform(0.5) }));
    const sq = ASL.node(() => osc({ freq: uniform(400), type: 'varshape', width: uniform(1) }));
    const a = compileVoice(tri);
    const b = compileVoice(saw);
    const c = compileVoice(sq);
    const sa = a.createState();
    const sb = b.createState();
    const sc = c.createState();
    a.noteOn(sa, {});
    b.noteOn(sb, {});
    c.noteOn(sc, {});
    const firstTri = a.renderSample(sa, SR);
    const firstSaw = b.renderSample(sb, SR);
    const firstSq = c.renderSample(sc, SR);
    expect(firstTri).toBeCloseTo(-1, 5);
    expect(firstSaw).toBeCloseTo(-1, 5);
    expect(firstSq).toBeCloseTo(1, 5);
  });

  it('supersquare and harmonic stay bounded and differ from sine', () => {
    const superSq = ASL.node(() => osc({ freq: uniform(220), type: 'supersquare', width: uniform(0.4) }));
    const harm = ASL.node(() => osc({ freq: uniform(220), type: 'harmonic', width: uniform(0.7) }));
    const sine = ASL.node(() => osc({ freq: uniform(220), type: 'sine' }));
    const voices = [superSq, harm, sine].map((graph) => compileVoice(graph));
    const states = voices.map((voice) => {
      const state = voice.createState();
      voice.noteOn(state, {});
      return state;
    });
    let superDiff = 0;
    let harmDiff = 0;
    for (let i = 0; i < 256; i++) {
      const s0 = voices[0]!.renderSample(states[0]!, SR);
      const s1 = voices[1]!.renderSample(states[1]!, SR);
      const s2 = voices[2]!.renderSample(states[2]!, SR);
      expect(s0).toBeGreaterThanOrEqual(-1.0001);
      expect(s0).toBeLessThanOrEqual(1.0001);
      expect(s1).toBeGreaterThanOrEqual(-1.0001);
      expect(s1).toBeLessThanOrEqual(1.0001);
      superDiff = Math.max(superDiff, Math.abs(s0 - s2));
      harmDiff = Math.max(harmDiff, Math.abs(s1 - s2));
    }
    expect(superDiff).toBeGreaterThan(0.1);
    expect(harmDiff).toBeGreaterThan(0.05);
  });

  it('triangle is bounded in [-1, 1] and symmetric', () => {
    const graph = ASL.node(() => osc({ freq: uniform(500), type: 'triangle' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});

    let max = -Infinity;
    let min = Infinity;
    const periodSamples = SR / 500;
    for (let i = 0; i < periodSamples; i++) {
      const sample = voice.renderSample(state, SR);
      max = Math.max(max, sample);
      min = Math.min(min, sample);
    }
    expect(max).toBeCloseTo(1, 1);
    expect(min).toBeCloseTo(-1, 1);
  });
});

describe('toFrequency', () => {
  it('converts MIDI note 69 to 440Hz', () => {
    const graph = ASL.node(() => uniform(69).toFrequency());
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(440, 5);
  });

  it('converts MIDI note 60 to ~261.63Hz (middle C)', () => {
    const graph = ASL.node(() => uniform(60).toFrequency());
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(261.626, 2);
  });

  it('reads a runtime param when wired through ASL.node inputs', () => {
    const graph = ASL.node(({ note }) => uniform(note).toFrequency());
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { note: 57 }); // A3 = 220Hz
    expect(voice.renderSample(state, SR)).toBeCloseTo(220, 5);
  });
});

describe('range', () => {
  it('maps a stationary -1..1 source onto [min, max]', () => {
    // rate 0 -> phase never advances -> sine(0) == 0 -> midpoint of the range
    const graph = ASL.node(() => lfo({ rate: uniform(0), shape: 'sine' }).range(400, 2400));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(1400, 5);
  });
});

describe('mix', () => {
  it('sums its sources sample-by-sample', () => {
    const a = ASL.node(() => osc({ freq: uniform(300), type: 'sine' }));
    const b = ASL.node(() => osc({ freq: uniform(700), type: 'sine' }));
    const summed = ASL.node(() => mix(osc({ freq: uniform(300), type: 'sine' }), osc({ freq: uniform(700), type: 'sine' })));

    const voiceA = compileVoice(a);
    const voiceB = compileVoice(b);
    const voiceSum = compileVoice(summed);
    const stateA = voiceA.createState();
    const stateB = voiceB.createState();
    const stateSum = voiceSum.createState();
    voiceA.noteOn(stateA, {});
    voiceB.noteOn(stateB, {});
    voiceSum.noteOn(stateSum, {});

    for (let i = 0; i < 20; i++) {
      const sa = voiceA.renderSample(stateA, SR);
      const sb = voiceB.renderSample(stateB, SR);
      const ss = voiceSum.renderSample(stateSum, SR);
      expect(ss).toBeCloseTo(sa + sb, 10);
    }
  });
});

describe('env.adsr', () => {
  function buildEnvGraph() {
    return ASL.node(({ velocity }) => env.adsr({ a: 0.01, d: 0.02, s: 0.5, r: 0.03 }).trigger(uniform(velocity)));
  }

  it('is silent before any noteOn', () => {
    const voice = compileVoice(buildEnvGraph());
    const state = voice.createState();
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('ramps linearly from 0 to velocity over the attack time', () => {
    const voice = compileVoice(buildEnvGraph());
    const state = voice.createState();
    voice.noteOn(state, { velocity: 0.8 });

    const attackSamples = Math.round(0.01 * SR);
    const out = new Float32Array(attackSamples);
    voice.renderBlock(state, SR, out);

    expect(out[0]).toBeGreaterThan(0);
    expect(out[attackSamples - 1]).toBeCloseTo(0.8, 1);
    // strictly increasing through the attack stage
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]!);
    }
  });

  it('settles at sustain * velocity after attack + decay elapse', () => {
    const voice = compileVoice(buildEnvGraph());
    const state = voice.createState();
    voice.noteOn(state, { velocity: 1.0 });

    const settleSamples = Math.round((0.01 + 0.02 + 0.01) * SR); // attack + decay + margin
    const out = new Float32Array(settleSamples);
    voice.renderBlock(state, SR, out);

    expect(out[out.length - 1]).toBeCloseTo(0.5, 2); // s: 0.5, velocity 1.0
  });

  it('releases linearly toward 0 after noteOff, then stays silent', () => {
    const voice = compileVoice(buildEnvGraph());
    const state = voice.createState();
    voice.noteOn(state, { velocity: 1.0 });

    // run past sustain
    voice.renderBlock(state, SR, new Float32Array(Math.round(0.05 * SR)));
    const levelBeforeRelease = voice.renderSample(state, SR);
    expect(levelBeforeRelease).toBeCloseTo(0.5, 2);

    voice.noteOff(state);
    const releaseSamples = Math.round(0.03 * SR);
    const out = new Float32Array(releaseSamples + 10);
    voice.renderBlock(state, SR, out);

    expect(out[releaseSamples - 1]).toBeCloseTo(0, 1);
    expect(out[out.length - 1]).toBe(0); // fully idle, silent, after release completes

    // strictly decreasing through the release stage
    for (let i = 1; i < releaseSamples; i++) {
      expect(out[i]).toBeLessThanOrEqual(out[i - 1]!);
    }
  });
});

describe('filter.lowpass', () => {
  it('has unity DC gain: a constant input converges to the same constant output', () => {
    const graph = ASL.node(() => filter.lowpass(uniform(1), { cutoff: uniform(500), q: uniform(0.707) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});

    let last = 0;
    for (let i = 0; i < 5000; i++) {
      last = voice.renderSample(state, SR);
    }
    expect(last).toBeCloseTo(1, 3);
  });

  it('attenuates a high-frequency signal more with a lower cutoff', () => {
    function rmsAfterFilter(cutoff: number): number {
      const graph = ASL.node(() => filter.lowpass(osc({ freq: uniform(8000), type: 'square' }), { cutoff: uniform(cutoff), q: uniform(0.707) }));
      const voice = compileVoice(graph);
      const state = voice.createState();
      voice.noteOn(state, {});
      // discard the filter's transient response before measuring
      voice.renderBlock(state, SR, new Float32Array(500));
      const block = new Float32Array(1000);
      voice.renderBlock(state, SR, block);
      const sumSquares = block.reduce((sum, v) => sum + v * v, 0);
      return Math.sqrt(sumSquares / block.length);
    }

    const rmsLowCutoff = rmsAfterFilter(200);
    const rmsHighCutoff = rmsAfterFilter(15000);
    expect(rmsLowCutoff).toBeLessThan(rmsHighCutoff);
  });
});

describe('filter shelves and kernel seams', () => {
  it('a 0 dB low shelf is an exact bypass', () => {
    const graph = ASL.node(() => filter.lowshelf(uniform(0.42), { freq: uniform(80), gainDb: uniform(0) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(0.42);
  });

  it('a 0 dB high shelf is an exact bypass', () => {
    const graph = ASL.node(() => filter.highshelf(uniform(-0.3), { freq: uniform(8000), gainDb: uniform(0) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(-0.3);
  });

  it('a boosted low shelf raises RMS of a 80 Hz tone', () => {
    function rms(gainDb: number): number {
      const graph = ASL.node(() =>
        filter.lowshelf(osc({ freq: uniform(80), type: 'sine' }), { freq: uniform(80), gainDb: uniform(gainDb) }),
      );
      const voice = compileVoice(graph);
      const state = voice.createState();
      voice.noteOn(state, {});
      voice.renderBlock(state, SR, new Float32Array(500));
      const block = new Float32Array(1000);
      voice.renderBlock(state, SR, block);
      return Math.sqrt(block.reduce((sum, v) => sum + v * v, 0) / block.length);
    }
    expect(rms(12)).toBeGreaterThan(rms(0));
  });

  it('an unbound kernel seam passes through rather than emitting silence', () => {
    // An AudioMaterial whose engine failed to load must still sound like the rest of
    // its graph. Silence here would be indistinguishable from a broken chain.
    const graph = ASL.node(() => kernel.seam('anything', uniform(0.25)));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(0.25);
    expect(voice.seamSlots).toEqual(['anything']);
    expect(voice.sourceSlot).toBeNull();
  });

  it('runs a bound seam kernel over the block and feeds the result downstream', () => {
    const graph = ASL.node(({ input }) => kernel.seam('gain2x', input).mul(uniform(0.5)));
    const voice = compileVoice(graph);
    const state = voice.createState();
    const seen: number[] = [];
    state.kernels = new Map([
      [
        'gain2x',
        {
          processSeam(inBuf: Float32Array, outBuf: Float32Array) {
            for (let i = 0; i < inBuf.length; i++) {
              seen.push(inBuf[i]!);
              outBuf[i] = inBuf[i]! * 2;
            }
          },
        },
      ],
    ]);
    voice.noteOn(state, {});
    const out = new Float32Array(4);
    voice.renderBlock(state, SR, out, Float32Array.from([1, 2, 3, 4]));
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('a source kernel replaces the graph, and falls back per its declared role', () => {
    const effect = compileVoice(ASL.node(({ input }) => kernel.source('eng', input, { fallback: 'passthrough' })));
    const effectState = effect.createState();
    const effectOut = new Float32Array(3);
    effect.renderBlock(effectState, SR, effectOut, Float32Array.from([0.1, 0.2, 0.3]));
    expect(Array.from(effectOut)).toEqual(Array.from(Float32Array.from([0.1, 0.2, 0.3])));
    expect(effect.sourceSlot).toBe('eng');

    const instrument = compileVoice(ASL.node(() => kernel.source('eng', undefined, { fallback: 'silence' })));
    const instrumentState = instrument.createState();
    const instrumentOut = Float32Array.from([9, 9, 9]);
    instrument.renderBlock(instrumentState, SR, instrumentOut, Float32Array.from([0.1, 0.2, 0.3]));
    expect(Array.from(instrumentOut)).toEqual([0, 0, 0]);

    instrumentState.kernels = new Map([
      ['eng', { processSource: (_l: Float32Array, _r: unknown, outL: Float32Array) => outL.fill(0.5) }],
    ]);
    instrument.renderBlock(instrumentState, SR, instrumentOut);
    expect(Array.from(instrumentOut)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('example voice, end to end', () => {
  function buildVoice() {
    return ASL.node(({ note, velocity }) => {
      const freq = uniform(note).toFrequency();
      const amp = env.adsr({ a: 0.005, d: 0.12, s: 0.6, r: 0.35 }).trigger(velocity);
      const carrier = mix(osc({ freq, type: 'saw' }).mul(0.7), osc({ freq: freq.mul(1.003), type: 'saw' }).mul(0.3));
      const cutoff = lfo({ rate: 0.3, shape: 'sine' }).range(400, 2400);
      return filter.lowpass(carrier, { cutoff, q: 0.8 }).mul(amp);
    });
  }

  it('renders finite, bounded audio for a full note-on/note-off cycle', () => {
    const voice = compileVoice(buildVoice());
    const state = voice.createState();
    voice.noteOn(state, { note: 69, velocity: 0.9 });

    const heldSamples = Math.round(0.3 * SR);
    const held = new Float32Array(heldSamples);
    voice.renderBlock(state, SR, held);

    voice.noteOff(state);
    const releaseSamples = Math.round(0.4 * SR);
    const release = new Float32Array(releaseSamples);
    voice.renderBlock(state, SR, release);

    for (const sample of [...held, ...release]) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThanOrEqual(1.1); // envelope peak 0.9, unity-ish filter gain, small headroom
    }

    // fully released and silent well after the release tail
    expect(release[release.length - 1]).toBeCloseTo(0, 1);
  });

  it('shares the freq subgraph between both detuned oscillators (computed once per sample)', () => {
    const graph = buildVoice();
    // graph.output is the final `.mul(amp)`: inputs.a is the filterLowpass node,
    // whose `input` is the mix node carrying the two detuned-oscillator chains.
    const topMul = graph.output;
    const filterNode = topMul.inputs.a!;
    const mixNode = filterNode.inputs.input!;
    const [osc1MulNode, osc2MulNode] = mixNode.list!; // each is `osc(...).mul(0.7 | 0.3)`
    const osc1 = osc1MulNode!.inputs.a!; // the osc node itself
    const osc2FreqMulNode = osc2MulNode!.inputs.a!.inputs.freq!; // osc2's freq input is `freq.mul(1.003)`
    // freq = uniform(note).toFrequency() feeds osc1 directly and osc2 via freq.mul(1.003);
    // both must reference the exact same underlying node instance.
    expect(osc1.inputs.freq).toBe(osc2FreqMulNode.inputs.a);
  });
});

describe('filter.highpass / bandpass / notch', () => {
  it('highpass rejects DC after settling', () => {
    const graph = ASL.node(() => filter.highpass(uniform(1), { cutoff: uniform(200), q: uniform(0.707) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    let last = 1;
    for (let i = 0; i < 8000; i++) last = voice.renderSample(state, SR);
    expect(Math.abs(last)).toBeLessThan(0.05);
  });

  it('notch at 0 dB-equivalent still passes a far-away tone', () => {
    const graph = ASL.node(() =>
      filter.notch(osc({ freq: uniform(80), type: 'sine' }), { cutoff: uniform(4000), q: uniform(1) }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    voice.renderBlock(state, SR, new Float32Array(400));
    const block = new Float32Array(800);
    voice.renderBlock(state, SR, block);
    const rms = Math.sqrt(block.reduce((s, v) => s + v * v, 0) / block.length);
    expect(rms).toBeGreaterThan(0.4);
  });
});

describe('noise / delay / clip / dc / envFollow', () => {
  it('white noise is bounded and not silent', () => {
    const graph = ASL.node(() => noise({ color: 'white' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    let energy = 0;
    for (let i = 0; i < 200; i++) {
      const s = voice.renderSample(state, SR);
      expect(Math.abs(s)).toBeLessThanOrEqual(1);
      energy += s * s;
    }
    expect(energy).toBeGreaterThan(0);
  });

  it('pink brown blue violet and grey stay bounded and make sound', () => {
    for (const color of ['pink', 'brown', 'blue', 'violet', 'grey'] as const) {
      const graph = ASL.node(() => noise({ color }));
      const voice = compileVoice(graph);
      const state = voice.createState();
      voice.noteOn(state, {});
      let energy = 0;
      for (let i = 0; i < 800; i++) {
        const s = voice.renderSample(state, SR);
        expect(Number.isFinite(s)).toBe(true);
        expect(Math.abs(s)).toBeLessThanOrEqual(1.0001);
        energy += s * s;
      }
      expect(energy, color).toBeGreaterThan(0);
    }
  });

  it('delay at mix 0 is a passthrough', () => {
    const graph = ASL.node(() => delay(uniform(0.33), { timeSec: uniform(0.1), mix: uniform(0) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.33, 10);
  });

  it('hard clip at drive 1 is identity inside [-1, 1]', () => {
    const graph = ASL.node(() => clip(uniform(0.4), { drive: uniform(1), mode: 'hard' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.4, 10);
  });

  it('dc blocker removes a constant after settling', () => {
    const graph = ASL.node(() => dcBlock(uniform(0.8)));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    let last = 0.8;
    for (let i = 0; i < 4000; i++) last = voice.renderSample(state, SR);
    expect(Math.abs(last)).toBeLessThan(0.05);
  });

  it('envelope follower tracks a held high input toward 1', () => {
    const graph = ASL.node(() => envFollow(uniform(1), { attack: uniform(0.001), release: uniform(0.1) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    voice.renderBlock(state, SR, new Float32Array(Math.round(0.02 * SR)));
    expect(voice.renderSample(state, SR)).toBeGreaterThan(0.9);
  });

  it('pulse width 0.25 spends a quarter of the period high', () => {
    const graph = ASL.node(() => osc({ freq: uniform(1000), type: 'pulse', width: uniform(0.25) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    const period = SR / 1000;
    let high = 0;
    for (let i = 0; i < period; i++) {
      if (voice.renderSample(state, SR) > 0) high++;
    }
    expect(high).toBeGreaterThan(period * 0.2);
    expect(high).toBeLessThan(period * 0.35);
  });
});

describe('filter primitives: one-pole / allpass / svf / ladder / comb', () => {
  it('one-pole lowpass has unity DC gain', () => {
    const graph = ASL.node(() => filter.onePoleLowpass(uniform(0.6), { cutoff: uniform(80) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    let last = 0;
    for (let i = 0; i < 8000; i++) last = voice.renderSample(state, SR);
    expect(last).toBeCloseTo(0.6, 2);
  });

  it('one-pole highpass rejects DC after settling', () => {
    const graph = ASL.node(() => filter.onePoleHighpass(uniform(1), { cutoff: uniform(200) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    let last = 1;
    for (let i = 0; i < 8000; i++) last = voice.renderSample(state, SR);
    expect(Math.abs(last)).toBeLessThan(0.05);
  });

  it('allpass keeps RMS of a sine near unity', () => {
    const graph = ASL.node(() =>
      filter.allpass(osc({ freq: uniform(440), type: 'sine' }), { cutoff: uniform(1000), q: uniform(0.707) }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    voice.renderBlock(state, SR, new Float32Array(400));
    const block = new Float32Array(800);
    voice.renderBlock(state, SR, block);
    const rms = Math.sqrt(block.reduce((s, v) => s + v * v, 0) / block.length);
    expect(rms).toBeGreaterThan(0.55);
    expect(rms).toBeLessThan(0.85);
  });

  it('SVF lowpass has unity DC gain', () => {
    const graph = ASL.node(() =>
      filter.svf(uniform(0.4), { cutoff: uniform(200), q: uniform(0.5), mode: 'lowpass' }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    let last = 0;
    for (let i = 0; i < 8000; i++) last = voice.renderSample(state, SR);
    expect(last).toBeCloseTo(0.4, 2);
  });

  it('ladder at resonance 0 has unity DC gain', () => {
    const graph = ASL.node(() =>
      filter.ladder(uniform(0.5), { cutoff: uniform(200), resonance: uniform(0) }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    let last = 0;
    for (let i = 0; i < 12000; i++) last = voice.renderSample(state, SR);
    expect(last).toBeCloseTo(0.5, 2);
  });

  it('comb at mix 0 is a passthrough', () => {
    const graph = ASL.node(() => filter.comb(uniform(0.22), { freq: uniform(220), mix: uniform(0) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.22, 10);
  });
});

describe('nonlinear and control nodes', () => {
  it('bitcrush at 16 bits is identity inside the representable grid', () => {
    const graph = ASL.node(() => bitcrush(uniform(0.5), { bits: uniform(16) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.5, 4);
  });

  it('downsample factor 1 is identity', () => {
    const graph = ASL.node(() => downsample(uniform(0.31), { factor: uniform(1) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.31, 10);
  });

  it('full-wave rectify folds negative samples', () => {
    const graph = ASL.node(() => rectify(uniform(-0.4), { mode: 'full' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.4, 10);
  });

  it('half-wave rectify silences negatives', () => {
    const graph = ASL.node(() => rectify(uniform(-0.4), { mode: 'half' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('slew with huge rates tracks a step', () => {
    const graph = ASL.node(() => slew(uniform(0.8), { rise: uniform(10000), fall: uniform(10000) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    for (let i = 0; i < 20; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.8, 2);
  });

  it('sample-and-hold of a constant is that constant', () => {
    const graph = ASL.node(() => sampleHold(uniform(0.17), { freq: uniform(40) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.17, 10);
  });

  it('compare greater emits 0 or 1', () => {
    const graph = ASL.node(() => compare(uniform(0.4), { threshold: uniform(0), mode: 'gt' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(1);
  });

  it('compressor below threshold is identity', () => {
    const graph = ASL.node(() =>
      compressor(uniform(0.2), { threshold: uniform(0.5), ratio: uniform(4) }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.2, 10);
  });
});

function countPulses(graph: ReturnType<typeof ASL.node>, samples: number): number {
  const voice = compileVoice(graph);
  const state = voice.createState();
  voice.noteOn(state, {});
  let pulses = 0;
  for (let i = 0; i < samples; i++) {
    if (voice.renderSample(state, SR) > 0.5) pulses += 1;
  }
  return pulses;
}

describe('control: clock, logic, quantize', () => {
  it('clock at 100 Hz emits one pulse per period', () => {
    const period = SR / 100;
    expect(countPulses(ASL.node(() => clock({ freq: uniform(100) })), period * 10)).toBe(10);
  });

  it('clock divide by 2 halves the incoming pulse rate', () => {
    const period = SR / 100;
    const graph = ASL.node(() => clockDivide(clock({ freq: uniform(100) }), { factor: uniform(2) }));
    expect(countPulses(graph, period * 10)).toBe(5);
  });

  it('clock multiply by 2 emits two pulses per incoming period after the first', () => {
    const graph = ASL.node(() => clockMultiply(clock({ freq: uniform(SR / 100) }), { factor: uniform(2) }));
    expect(countPulses(graph, 400)).toBeGreaterThanOrEqual(6);
    expect(countPulses(graph, 400)).toBeLessThanOrEqual(8);
  });

  it('logic and / or / not / xor', () => {
    const andGraph = ASL.node(() => logic.and(uniform(1), uniform(1)));
    const orGraph = ASL.node(() => logic.or(uniform(0), uniform(1)));
    const notGraph = ASL.node(() => logic.not(uniform(1)));
    const xorGraph = ASL.node(() => logic.xor(uniform(1), uniform(1)));
    for (const [graph, expected] of [
      [andGraph, 1],
      [orGraph, 1],
      [notGraph, 0],
      [xorGraph, 0],
    ] as const) {
      const voice = compileVoice(graph);
      const state = voice.createState();
      voice.noteOn(state, {});
      expect(voice.renderSample(state, SR)).toBe(expected);
    }
  });

  it('flip flop toggles on successive clocks', () => {
    const graph = ASL.node(() => flipFlop(clock({ freq: uniform(100) })));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    const first = voice.renderSample(state, SR);
    for (let i = 1; i < SR / 100; i++) voice.renderSample(state, SR);
    const second = voice.renderSample(state, SR);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('quantize snaps C# to C on a C major scale', () => {
    expect(quantizeToScale(61, 0, 0)).toBe(60);
    expect(quantizeToScale(62, 0, 0)).toBe(62);
    const graph = ASL.node(() => quantize(uniform(61), { root: uniform(0), scale: uniform(0) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(60);
  });

  it('euclidean 3-in-8 matches the Bresenham pattern', () => {
    expect(euclideanPattern(8, 3, 0).filter(Boolean).length).toBe(3);
    const graph = ASL.node(() =>
      euclidean(clock({ freq: uniform(100) }), { steps: uniform(8), hits: uniform(3), rotation: uniform(0) }),
    );
    expect(countPulses(graph, (SR / 100) * 8)).toBe(3);
  });

  it('trigger emits a one-sample pulse on a rising edge', () => {
    const graph = ASL.node(() => trigger(uniform(0.8), { threshold: uniform(0.5) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(1);
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('pulse holds high for widthSec after a trigger', () => {
    const graph = ASL.node(() => pulse(clock({ freq: uniform(1) }), { widthSec: uniform(3 / SR) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBe(1);
    expect(voice.renderSample(state, SR)).toBe(1);
    expect(voice.renderSample(state, SR)).toBe(1);
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('sequencer advances one step per clock', () => {
    const graph = ASL.node(() => sequencer(clock({ freq: uniform(100) }), [uniform(0.1), uniform(0.7)]));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.1, 10);
    for (let i = 1; i < SR / 100; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.7, 10);
  });

  it('random stepped stays in [-1, 1]', () => {
    const graph = ASL.node(() => random({ freq: uniform(200), mode: 'stepped' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    for (let i = 0; i < 200; i++) {
      const s = voice.renderSample(state, SR);
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('DAHDSR stays low during delay then rises on attack', () => {
    const graph = ASL.node(() =>
      env.dahdsr({
        delay: uniform(0.01),
        attack: uniform(0.01),
        hold: uniform(0),
        decay: uniform(0.01),
        sustain: uniform(0.5),
        release: uniform(0.01),
      }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    for (let i = 0; i < Math.round(0.005 * SR); i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeLessThan(0.15);
    for (let i = 0; i < Math.round(0.02 * SR); i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeGreaterThan(0.4);
  });
});

describe('remaining section 5 primitives', () => {
  it('impulse fires once then stays silent', () => {
    const graph = ASL.node(() => impulse());
    const voice = compileVoice(graph);
    const state = voice.createState();
    expect(voice.renderSample(state, SR)).toBe(1);
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('expander above threshold is identity', () => {
    const graph = ASL.node(() => expander(uniform(0.8), { threshold: uniform(0.2), ratio: uniform(2) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    for (let i = 0; i < 2000; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.8, 5);
  });

  it('transient at 0,0 is identity after settling', () => {
    const graph = ASL.node(() => transient(uniform(0.3), { attack: uniform(0), sustain: uniform(0) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    for (let i = 0; i < 200; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.3, 2);
  });

  it('select picks A then B', () => {
    const a = ASL.node(() => select(uniform(0.2), uniform(0.9), { which: uniform(0) }));
    const b = ASL.node(() => select(uniform(0.2), uniform(0.9), { which: uniform(1) }));
    for (const [graph, expected] of [
      [a, 0.2],
      [b, 0.9],
    ] as const) {
      const voice = compileVoice(graph);
      const state = voice.createState();
      expect(voice.renderSample(state, SR)).toBeCloseTo(expected, 10);
    }
  });

  it('waveshape identity curve is identity', () => {
    const graph = ASL.node(() => waveshape(uniform(0.4), { curve: [-1, 0, 1] }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.4, 10);
  });

  it('breakpoint envelope holds the last level', () => {
    const graph = ASL.node(() => env.breakpoints({ times: [0, 0.001], levels: [0, 0.8] }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    for (let i = 0; i < 80; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.8, 2);
  });

  it('rms of a constant is the constant', () => {
    const graph = ASL.node(() => rms(uniform(0.5), { windowSec: uniform(0.002) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    for (let i = 0; i < 200; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.5, 2);
  });

  it('peak tracks a held high sample', () => {
    const graph = ASL.node(() => peak(uniform(0.7), { release: uniform(2) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.7, 2);
  });

  it('slope lowpass has unity DC gain', () => {
    const graph = ASL.node(() => filter.slope(uniform(0.55), { cutoff: uniform(80), poles: 2, mode: 'lowpass' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    let last = 0;
    for (let i = 0; i < 8000; i++) last = voice.renderSample(state, SR);
    expect(last).toBeCloseTo(0.55, 2);
  });

  it('wavetable position morphs between frames', () => {
    const table = new Float32Array(16);
    for (let i = 0; i < 8; i++) table[i] = 0.2;
    for (let i = 8; i < 16; i++) table[i] = 0.8;
    function at(position: number): number {
      const graph = ASL.node(() =>
        wavetable({ freq: uniform(0), table, position: uniform(position), frameSize: 8 }),
      );
      const voice = compileVoice(graph);
      const state = voice.createState();
      return voice.renderSample(state, SR);
    }
    expect(at(0)).toBeCloseTo(0.2, 5);
    expect(at(1)).toBeCloseTo(0.8, 5);
    expect(at(0.5)).toBeCloseTo(0.5, 5);
  });

  it('wavetable sine is bounded', () => {
    const table = new Float32Array(64);
    for (let i = 0; i < 64; i++) table[i] = Math.sin((2 * Math.PI * i) / 64);
    const graph = ASL.node(() => wavetable({ freq: uniform(440), table }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    for (let i = 0; i < 64; i++) {
      expect(Math.abs(voice.renderSample(state, SR))).toBeLessThanOrEqual(1.001);
    }
  });

  it('sample play of a short table emits then stops', () => {
    const table = new Float32Array([0.2, 0.4, 0.6, 0.8]);
    const graph = ASL.node(() => samplePlay({ rate: uniform(1), table }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    const first = voice.renderSample(state, SR);
    expect(first).toBeCloseTo(0.2, 5);
    for (let i = 0; i < 8; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('grain of an empty table is silent', () => {
    const graph = ASL.node(() => grain(uniform(1), { table: new Float32Array(0) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('looper records then plays back', () => {
    const graph = ASL.node(({ rec }) => looper(uniform(0.33), { record: rec, maxTimeSec: 0.01 }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1 });
    for (let i = 0; i < 20; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.33, 5);
  });

  it('looper overdub sums into the loop and undo restores the snapshot', () => {
    const graph = ASL.node(({ rec, dub, undo, x }) =>
      looper(x, { record: rec, overdub: dub, undo, maxTimeSec: 0.01 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1, dub: 0, undo: 0, x: 0.25 });
    for (let i = 0; i < 8; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.25, 5);
    state.params.dub = 1;
    state.params.x = 0.5;
    const firstDub = voice.renderSample(state, SR);
    expect(firstDub).toBeCloseTo(0.75, 5);
    state.params.dub = 0;
    state.params.undo = 1;
    voice.renderSample(state, SR);
    state.params.undo = 0;
    const restored: number[] = [];
    for (let i = 0; i < 8; i++) restored.push(voice.renderSample(state, SR));
    expect(restored.some((v) => Math.abs(v - 0.25) < 1e-5)).toBe(true);
    expect(restored.every((v) => Math.abs(v - 0.75) > 1e-4)).toBe(true);
  });

  it('looper threshold disarms if record is released before a peak', () => {
    const graph = ASL.node(({ rec, x }) =>
      looper(x, { record: rec, threshold: uniform(0.4), maxTimeSec: 0.01 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1, x: 0.1 });
    for (let i = 0; i < 6; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    for (let i = 0; i < 2; i++) voice.renderSample(state, SR);
    state.params.x = 0.8;
    for (let i = 0; i < 8; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('looper threshold waits for the input peak before capturing', () => {
    const graph = ASL.node(({ rec, x }) =>
      looper(x, { record: rec, threshold: uniform(0.4), maxTimeSec: 0.01 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1, x: 0.1 });
    for (let i = 0; i < 6; i++) voice.renderSample(state, SR);
    state.params.x = 0.8;
    for (let i = 0; i < 4; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    state.params.x = 0;
    const played: number[] = [];
    for (let i = 0; i < 6; i++) played.push(voice.renderSample(state, SR));
    expect(played.includes(0.1)).toBe(false);
    expect(played.some((v) => Math.abs(v - 0.8) < 1e-5)).toBe(true);
  });

  it('looper quantize snaps the loop length to a beat', () => {
    const graph = ASL.node(({ rec, x }) =>
      looper(x, { record: rec, quantize: uniform(1), maxTimeSec: 1 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    state.transport = { beats: 0, bpm: 120, playing: true, beatsPerBar: 4 };
    voice.noteOn(state, { rec: 1, x: 1 });
    voice.renderSample(state, SR);
    state.params.x = 0;
    for (let i = 0; i < 17999; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    const hits: number[] = [];
    for (let i = 0; i < 36000; i++) {
      if (Math.abs(voice.renderSample(state, SR)) > 0.5) hits.push(i);
    }
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1]! - hits[0]!).toBe(24000);
  });

  it('looper quantize in 6/8 snaps to an eighth, not a quarter', () => {
    const graph = ASL.node(({ rec, x }) =>
      looper(x, { record: rec, quantize: uniform(1), maxTimeSec: 1 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    state.transport = { beats: 0, bpm: 120, playing: true, beatsPerBar: 6, beatUnit: 8 };
    voice.noteOn(state, { rec: 1, x: 1 });
    voice.renderSample(state, SR);
    state.params.x = 0;
    for (let i = 0; i < 8999; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    const hits: number[] = [];
    for (let i = 0; i < 20000; i++) {
      if (Math.abs(voice.renderSample(state, SR)) > 0.5) hits.push(i);
    }
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1]! - hits[0]!).toBe(12000);
  });

  it('looper play gate is silent until play goes high', () => {
    const graph = ASL.node(({ rec, play }) =>
      looper(uniform(0.4), { record: rec, play, maxTimeSec: 0.01 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1, play: 0 });
    for (let i = 0; i < 8; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    expect(voice.renderSample(state, SR)).toBe(0);
    state.params.play = 1;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.4, 5);
  });

  it('looper bars auto-closes a take while record stays held', () => {
    const graph = ASL.node(({ rec, x }) =>
      looper(x, { record: rec, bars: uniform(1), maxTimeSec: 4 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    state.transport = { beats: 0, bpm: 120, playing: true, beatsPerBar: 4, beatUnit: 4 };
    voice.noteOn(state, { rec: 1, x: 1 });
    voice.renderSample(state, SR);
    state.params.x = 0;
    const barFrames = 2 * SR;
    for (let i = 0; i < barFrames - 2; i++) voice.renderSample(state, SR);
    const hits: number[] = [];
    for (let i = 0; i < barFrames + 8; i++) {
      if (Math.abs(voice.renderSample(state, SR)) > 0.5) hits.push(i);
    }
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1]! - hits[0]!).toBe(barFrames);
  });

  it('looper start fires on the first play sample and each wrap', () => {
    const box = createLooperBox();
    const graph = ASL.node(({ rec }) =>
      looper(uniform(0.33), { record: rec, maxTimeSec: 0.01, box, field: 'start' }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1 });
    for (let i = 0; i < 8; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    const hits: number[] = [];
    for (let i = 0; i < 24; i++) {
      if (voice.renderSample(state, SR) > 0.5) hits.push(i);
    }
    expect(hits[0]).toBe(0);
    expect(hits[1]).toBe(8);
    expect(hits[2]).toBe(16);
  });

  it('looper end fires on the last sample of each cycle', () => {
    const box = createLooperBox();
    const graph = ASL.node(({ rec }) =>
      looper(uniform(0.33), { record: rec, maxTimeSec: 0.01, box, field: 'end' }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1 });
    for (let i = 0; i < 8; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    const hits: number[] = [];
    for (let i = 0; i < 24; i++) {
      if (voice.renderSample(state, SR) > 0.5) hits.push(i);
    }
    expect(hits[0]).toBe(7);
    expect(hits[1]).toBe(15);
    expect(hits[2]).toBe(23);
  });

  it('looper start and audio share one box', () => {
    const box = createLooperBox();
    const graph = ASL.node(({ rec }) =>
      mix(
        looper(uniform(0.25), { record: rec, maxTimeSec: 0.01, box, field: 'audio' }),
        looper(uniform(0.25), { record: rec, maxTimeSec: 0.01, box, field: 'start' }),
      ),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1 });
    for (let i = 0; i < 4; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    expect(voice.renderSample(state, SR)).toBeCloseTo(1.25, 5);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.25, 5);
  });

  it('looper play gate suppresses start and end pulses', () => {
    const box = createLooperBox();
    const graph = ASL.node(({ rec, play }) =>
      looper(uniform(0.4), { record: rec, play, maxTimeSec: 0.01, box, field: 'start' }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1, play: 0 });
    for (let i = 0; i < 8; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    expect(voice.renderSample(state, SR)).toBe(0);
    state.params.play = 1;
    expect(voice.renderSample(state, SR)).toBe(1);
  });

  it('looper duration of 0 is free-running, not a zero-length cap', () => {
    const graph = ASL.node(({ rec }) =>
      looper(uniform(0.22), { record: rec, duration: uniform(0), maxTimeSec: 0.01 }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, { rec: 1 });
    for (let i = 0; i < 20; i++) voice.renderSample(state, SR);
    state.params.rec = 0;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.22, 5);
  });

  it('pitch shift at 1 stays finite', () => {
    const graph = ASL.node(() => pitchShift(osc({ freq: uniform(220), type: 'sine' }), { pitch: uniform(1) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    for (let i = 0; i < 2000; i++) {
      expect(Number.isFinite(voice.renderSample(state, SR))).toBe(true);
    }
  });

  it('pan law at center is equal power', () => {
    const left = compileVoice(ASL.node(() => panLaw(uniform(1), { pan: uniform(0), channel: 'left' })));
    const right = compileVoice(ASL.node(() => panLaw(uniform(1), { pan: uniform(0), channel: 'right' })));
    const ls = left.createState();
    const rs = right.createState();
    const l = left.renderSample(ls, SR);
    const r = right.renderSample(rs, SR);
    expect(l).toBeCloseTo(r, 10);
    expect(l * l + r * r).toBeCloseTo(1, 5);
  });

  it('compressor sidechain below thresh is identity', () => {
    const graph = ASL.node(() =>
      compressor(uniform(0.8), { threshold: uniform(0.5), ratio: uniform(4), sidechain: uniform(0.1) }),
    );
    const voice = compileVoice(graph);
    const state = voice.createState();
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.8, 10);
  });

  it('onset stays quiet on a constant', () => {
    const graph = ASL.node(() => onset(uniform(0.4), { threshold: uniform(0.2) }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    for (let i = 0; i < 100; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBe(0);
  });

  it('reverse of a constant is that constant once the buffer fills', () => {
    const graph = ASL.node(() => reverse(uniform(0.25), { timeSec: uniform(0.001), maxTimeSec: 0.01 }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    for (let i = 0; i < 80; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.25, 10);
  });

  it('pitch locks a 440 Hz tone to MIDI 69', () => {
    const graph = ASL.node(() => pitch(osc({ freq: uniform(440) }), { field: 'midi' }));
    const voice = compileVoice(graph);
    const state = voice.createState();
    voice.noteOn(state, {});
    for (let i = 0; i < 1536; i++) voice.renderSample(state, SR);
    expect(voice.renderSample(state, SR)).toBeCloseTo(69, 0);
  });
});
