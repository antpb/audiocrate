/**
 * Taps are the one channel that carries data *out* of a rendering voice, so
 * the properties that matter are: they never change the signal, they never
 * double-count, and they cost nothing when nobody is reading.
 */
import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../src/asl/compile';
import { tap } from '../../src/asl/analysis';
import { kernel } from '../../src/asl/builders';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { fftMagnitude } from '../../src/dsp/fft';
import { yinPitch } from '../../src/dsp/yin';
import type { KernelProcessor } from '../../src/renderers/kernel';

const SR = 48000;

function sine(frames: number, hz: number, amplitude = 1): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

const metered = new AudioMaterial({
  name: 'Metered',
  kind: 'metered',
  params: {},
  channels: 1,
  graph: ({ input }) => tap.meter(input),
});

describe('tap.meter', () => {
  it('passes the signal through untouched', () => {
    const voice = compileVoice(metered.graph);
    const input = new Float32Array([1, -0.5, 0.25, 0]);
    const out = new Float32Array(4);
    voice.renderBlock(voice.createState(), SR, out, input);
    expect([...out]).toEqual([1, -0.5, 0.25, 0]);
  });

  it('reports peak and RMS of what went by', () => {
    const voice = compileVoice(metered.graph);
    const state = voice.createState();
    const input = new Float32Array([1, -1, 1, -1]);
    voice.renderBlock(state, SR, new Float32Array(4), input);

    const frame = voice.drainAnalysis(state)!;
    expect(frame.meters.meter!.peak).toBe(1);
    expect(frame.meters.meter!.rms).toBeCloseTo(1, 6);
  });

  it('covers only the interval since the previous read', () => {
    const voice = compileVoice(metered.graph);
    const state = voice.createState();

    voice.renderBlock(state, SR, new Float32Array(4), new Float32Array([1, 1, 1, 1]));
    expect(voice.drainAnalysis(state)!.meters.meter!.peak).toBe(1);

    // A loud block then a quiet one must not leave the meter pinned: each
    // frame is its own window, and any smoothing is the reader's decision.
    voice.renderBlock(state, SR, new Float32Array(4), new Float32Array([0.1, 0.1, 0.1, 0.1]));
    expect(voice.drainAnalysis(state)!.meters.meter!.peak).toBeCloseTo(0.1, 6);
  });

  it('reports silence rather than nothing when no samples were rendered', () => {
    const voice = compileVoice(metered.graph);
    const state = voice.createState();
    voice.renderBlock(state, SR, new Float32Array(4), new Float32Array(4));
    const frame = voice.drainAnalysis(state)!;
    expect(frame.meters.meter).toEqual({ peak: 0, rms: 0 });
  });

  it('does not double-count across a seam kernel is two evaluation passes', () => {
    // A seam graph walks the whole tree twice per sample, once to collect
    // and once to apply. A tap that recorded on both would report an RMS
    // that is correct only by accident.
    const seamed = new AudioMaterial({
      name: 'Seamed',
      kind: 'seamed',
      params: {},
      channels: 1,
      graph: ({ input }) => tap.meter(kernel.seam('test.seam', input)),
    });
    const voice = compileVoice(seamed.graph);
    const state = voice.createState();
    const passthrough: KernelProcessor = {
      processSeam: (input, output) => output.set(input),
    };
    state.kernels = new Map([['test.seam', passthrough]]);

    voice.renderBlock(state, SR, new Float32Array(8), new Float32Array(8).fill(0.5));
    const frame = voice.drainAnalysis(state)!;
    expect(frame.meters.meter!.rms).toBeCloseTo(0.5, 6);
  });

  it('records the left channel once on a stereo graph', () => {
    // Recording on both lanes would make a meter mean something different
    // depending on whether the graph happened to be stereo.
    const stereo = new AudioMaterial({
      name: 'StereoMetered',
      kind: 'stereometered',
      params: {},
      graph: ({ input }) => tap.meter(input),
    });
    const voice = compileVoice(stereo.graph);
    expect(voice.stereo).toBe(true);
    const state = voice.createState();
    voice.renderBlock(state, SR, new Float32Array(4), new Float32Array(4).fill(1), {
      inputR: new Float32Array(4).fill(0.25),
      outputR: new Float32Array(4),
    });
    const frame = voice.drainAnalysis(state)!;
    expect(frame.meters.meter!.peak).toBe(1);
    expect(frame.meters.meter!.rms).toBeCloseTo(1, 6);
  });
});

describe('tap.capture', () => {
  const captured = new AudioMaterial({
    name: 'Captured',
    kind: 'captured',
    params: {},
    channels: 1,
    graph: ({ input }) => tap.capture(input, { windowSize: 8 }),
  });

  it('passes the signal through untouched', () => {
    const voice = compileVoice(captured.graph);
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const out = new Float32Array(4);
    voice.renderBlock(voice.createState(), SR, out, input);
    expect([...out]).toEqual([...input].map((v) => Math.fround(v)));
  });

  it('returns a partial window before it has filled', () => {
    const voice = compileVoice(captured.graph);
    const state = voice.createState();
    voice.renderBlock(state, SR, new Float32Array(3), new Float32Array([1, 2, 3]));
    expect([...voice.drainAnalysis(state)!.captures.capture!]).toEqual([1, 2, 3]);
  });

  it('unrolls the ring oldest-sample-first once it wraps', () => {
    const voice = compileVoice(captured.graph);
    const state = voice.createState();
    const input = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    voice.renderBlock(state, SR, new Float32Array(10), input);
    // Window is 8, so the oldest two are gone and the rest are in order.
    expect([...voice.drainAnalysis(state)!.captures.capture!]).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('produces a window the main-thread analysers can read directly', () => {
    // The point of capturing rather than analysing on the audio thread: YIN
    // over a 2048 window is tens of millions of operations a second at
    // display rates, and the audio thread is the one place that cannot.
    const scope = new AudioMaterial({
      name: 'Scope',
      kind: 'scopetest',
      params: {},
      channels: 1,
      graph: ({ input }) => tap.capture(input, { windowSize: 2048 }),
    });
    const voice = compileVoice(scope.graph);
    const state = voice.createState();
    const input = sine(4096, 440);
    voice.renderBlock(state, SR, new Float32Array(4096), input);

    const window = voice.drainAnalysis(state)!.captures.capture!;
    expect(window).toHaveLength(2048);

    // Within a couple of Hz, not exact: YIN's tau resolution is integer
    // samples, so 2048 frames at 48 kHz cannot land closer than this. The
    // claim being made is that the window is a usable signal, not that the
    // detector is better than it is.
    expect(Math.abs(yinPitch(window, SR) - 440)).toBeLessThan(2);

    const spectrum = fftMagnitude(window);
    let loudest = 0;
    for (let i = 1; i < spectrum.length; i++) if (spectrum[i]! > spectrum[loudest]!) loudest = i;
    // Within one bin. 2048 frames at 48 kHz is 23.4 Hz of resolution, so
    // asking for closer than that would be asking the FFT for something it
    // cannot give rather than testing the capture.
    const binHz = SR / 2048;
    expect(Math.abs((loudest * SR) / 2048 - 440)).toBeLessThanOrEqual(binHz);
  });
});

describe('a graph with no taps', () => {
  it('reports nothing at all rather than an empty frame', () => {
    const plain = new AudioMaterial({
      name: 'Plain',
      kind: 'plain',
      params: {},
      graph: ({ input }) => input.mul(1),
    });
    const voice = compileVoice(plain.graph);
    expect(voice.taps).toEqual([]);
    expect(voice.drainAnalysis(voice.createState())).toBeNull();
  });

  it('lists the tap ids a graph does record under', () => {
    const both = new AudioMaterial({
      name: 'Both',
      kind: 'both',
      params: {},
      channels: 1,
      graph: ({ input }) => tap.capture(tap.meter(input, { id: 'level' }), { id: 'window' }),
    });
    expect(compileVoice(both.graph).taps).toEqual(['level', 'window']);
  });
});
