/**
 * Two things a graph could not do until ports existed: read a second live
 * signal, and know which channel it is on. Both are checked here against the
 * interpreter directly, because they are properties of the compiler rather
 * than of any particular Material.
 */
import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { audio, compressor, envFollow, filter, select, uniform } from '../../src/asl/builders';
import { compileVoice } from '../../src/asl/compile';
import { audioPortNames, auxAudioPorts } from '../../src/asl/ports';
import { Material } from '../../src/graph/Material';

const SR = 48000;

function ramp(length: number, from: number, to: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = from + ((to - from) * i) / Math.max(1, length - 1);
  return out;
}

describe('audio ports', () => {
  it('lists every port a graph reads, sorted, and separates the aux ones', () => {
    const material = new Material({
      name: 'Two',
      params: {},
      graph: ({ input, audio: a }) => input.add(a.sidechain()),
    });
    expect(audioPortNames(material.graph)).toEqual(['input', 'sidechain']);
    expect(auxAudioPorts(material.graph)).toEqual(['sidechain']);
    expect(material.auxAudioInputs).toEqual(['sidechain']);
  });

  it('reports no ports for a source Material, which is why it renders mono', () => {
    const material = new Material({
      name: 'Source',
      params: {},
      graph: ({ note }) => note.toFrequency().mul(0),
    });
    expect(audioPortNames(material.graph)).toEqual([]);
    expect(compileVoice(material.graph).stereo).toBe(false);
  });

  it('feeds a named aux port per sample', () => {
    const material = new Material({
      name: 'Ring',
      params: {},
      graph: ({ input, audio: a }) => input.mul(a.sidechain()),
    });
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    const input = new Float32Array([1, 1, 1, 1]);
    const key = new Float32Array([0, 0.5, 1, -1]);
    const out = new Float32Array(4);
    voice.renderBlock(state, SR, out, input, { ports: { sidechain: [key] } });
    expect([...out]).toEqual([0, 0.5, 1, -1]);
  });

  it('reads 0 from a port with nothing connected', () => {
    const material = new Material({
      name: 'Ring',
      params: {},
      graph: ({ input, audio: a }) => input.mul(a.sidechain()),
    });
    const voice = compileVoice(material.graph);
    const out = new Float32Array(4);
    voice.renderBlock(voice.createState(), SR, out, new Float32Array([1, 1, 1, 1]));
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it('keys a compressor off the sidechain rather than the input', () => {
    const graph = new Material({
      name: 'SC',
      params: {},
      graph: ({ input, audio: a }) =>
        compressor(input, { threshold: 0.1, ratio: 20, attack: 0.0001, release: 0.0001, sidechain: a.sidechain() }),
    }).graph;
    const voice = compileVoice(graph);
    const frames = 512;
    const input = new Float32Array(frames).fill(0.2);
    const quiet = new Float32Array(frames);
    const loud = new Float32Array(frames).fill(1);

    const open = new Float32Array(frames);
    voice.renderBlock(voice.createState(), SR, open, input, { ports: { sidechain: [quiet] } });
    const ducked = new Float32Array(frames);
    voice.renderBlock(voice.createState(), SR, ducked, input, { ports: { sidechain: [loud] } });

    // Same input both times. The only difference is what the detector saw.
    expect(Math.abs(ducked[frames - 1]!)).toBeLessThan(Math.abs(open[frames - 1]!));
  });

  it('still honours the scalar of the same name on the per-sample path', () => {
    // OfflineRenderer and renderSample have no blocks to index, so a port
    // falls back to `state.params[name]`. Graphs written before ports existed
    // depend on this.
    const graph = ASL.node(({ input }) => input.mul(2));
    const voice = compileVoice(graph);
    const state = voice.createState();
    state.params.input = 0.25;
    expect(voice.renderSample(state, SR)).toBeCloseTo(0.5, 6);
  });
});

describe('channels', () => {
  it('renders an effect once per channel with independent node state', () => {
    // One lowpass, two channels. If the two shared a biquad's delay line the
    // right channel's output would depend on the left's history; it does not.
    const material = new Material({
      name: 'LP',
      params: {},
      graph: ({ input }) => filter.lowpass(input, { cutoff: 800, q: 0.707 }),
    });
    const voice = compileVoice(material.graph);
    expect(voice.stereo).toBe(true);

    const frames = 256;
    const left = ramp(frames, -1, 1);
    const right = new Float32Array(frames);
    const outL = new Float32Array(frames);
    const outR = new Float32Array(frames);
    const wrote = voice.renderBlock(voice.createState(), SR, outL, left, { inputR: right, outputR: outR });

    expect(wrote).toBe(true);
    // A silent right input must produce a silent right output, not a copy of
    // the left channel. This is the mono-collapse bug the lanes exist to fix.
    expect(Math.max(...outR.map(Math.abs))).toBe(0);
    expect(Math.max(...outL.map(Math.abs))).toBeGreaterThan(0.1);
  });

  it('mirrors instead of rendering twice when the graph reads no audio', () => {
    const material = new Material({
      name: 'Tone',
      params: {},
      graph: ({ note }) => note.toFrequency().mul(0).add(0.5),
    });
    const voice = compileVoice(material.graph);
    expect(voice.stereo).toBe(false);
    const outL = new Float32Array(8);
    const outR = new Float32Array(8);
    expect(voice.renderBlock(voice.createState(), SR, outL, undefined, { outputR: outR })).toBe(false);
  });

  it('lets a graph behave differently per channel', () => {
    const material = new Material({
      name: 'HardPan',
      params: {},
      graph: ({ input, audio: a }) => select(input, uniform(0), { which: a.lane() }),
    });
    const voice = compileVoice(material.graph);
    const input = new Float32Array([1, 1, 1, 1]);
    const outL = new Float32Array(4);
    const outR = new Float32Array(4);
    voice.renderBlock(voice.createState(), SR, outL, input, { inputR: input, outputR: outR });
    expect([...outL]).toEqual([1, 1, 1, 1]);
    expect([...outR]).toEqual([0, 0, 0, 0]);
  });

  it('reads a fixed side regardless of the channel being rendered', () => {
    const material = new Material({
      name: 'Sum',
      params: {},
      graph: ({ audio: a }) => a.left().add(a.right()).mul(0.5),
    });
    const voice = compileVoice(material.graph);
    const left = new Float32Array([1, 1]);
    const right = new Float32Array([-1, 0]);
    const outL = new Float32Array(2);
    const outR = new Float32Array(2);
    voice.renderBlock(voice.createState(), SR, outL, left, { inputR: right, outputR: outR });
    expect([...outL]).toEqual([0, 0.5]);
    expect([...outR]).toEqual([0, 0.5]);
  });

  it('falls back to the left channel when the source is mono', () => {
    const material = new Material({
      name: 'Right',
      params: {},
      graph: ({ audio: a }) => a.right().mul(1),
    });
    const voice = compileVoice(material.graph);
    const out = new Float32Array(3);
    voice.renderBlock(voice.createState(), SR, out, new Float32Array([0.5, 0.5, 0.5]));
    expect([...out]).toEqual([0.5, 0.5, 0.5]);
  });

  it('honours an explicit channel count over the derived one', () => {
    const meter = new Material({
      name: 'Meter',
      params: {},
      channels: 1,
      graph: ({ input }) => envFollow(input),
    });
    expect(compileVoice(meter.graph).stereo).toBe(false);
  });
});
