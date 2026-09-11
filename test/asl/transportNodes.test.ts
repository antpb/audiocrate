import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../src/asl/compile';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { param } from '../../src/graph/param';
import { delay, uniform } from '../../src/asl/builders';
import {
  COMMON_DIVISION_BEATS,
  COMMON_DIVISION_NAMES,
  DEFAULT_TRANSPORT,
  SYNC_DIVISIONS,
  advanceTransport,
  barBeats,
  divisionBeats,
  signatureBeatBeats,
  transport,
  transportAt,
  type TransportSnapshot,
} from '../../src/asl/transportNodes';
import { OfflineRenderer } from '../../src/renderers/OfflineRenderer';
import { TempoMap } from '../../src/TempoMap';
import { syncedClockMaterial, syncedDelayMaterial, syncedRampMaterial } from '../../src/materials/synced';

const SR = 48000;

function renderGraph(
  material: AudioMaterial,
  frames: number,
  snapshot: Partial<TransportSnapshot> = {},
): Float32Array {
  const voice = compileVoice(material.graph);
  const state = voice.createState();
  state.params = material.snapshotParams();
  const out = new Float32Array(frames);
  voice.renderBlock(state, SR, out, undefined, {
    transport: { ...DEFAULT_TRANSPORT, playing: true, ...snapshot },
  });
  return out;
}

/** A one-node AudioMaterial wrapping a transport expression, so it can be rendered. */
function probe(build: () => ReturnType<typeof transport.beats>): AudioMaterial {
  return new AudioMaterial({ name: 'Probe', channels: 1, graph: () => build() });
}

describe('divisions', () => {
  it('agrees on what a note length is worth in beats', () => {
    expect(divisionBeats('1/4')).toBe(1);
    expect(divisionBeats('1/8')).toBe(0.5);
    expect(divisionBeats('1/2')).toBe(2);
    expect(divisionBeats('1/1')).toBe(4);
  });

  it('makes a dotted length one and a half, and a triplet two thirds', () => {
    expect(SYNC_DIVISIONS['1/8.']).toBeCloseTo(0.75, 12);
    expect(SYNC_DIVISIONS['1/8T']).toBeCloseTo(1 / 3, 12);
    expect(SYNC_DIVISIONS['1/4.']).toBeCloseTo(1.5, 12);
  });

  it('treats the time-signature denominator as a note value', () => {
    expect(signatureBeatBeats(4)).toBe(1);
    expect(signatureBeatBeats(8)).toBe(0.5);
    expect(signatureBeatBeats(2)).toBe(2);
    expect(barBeats(4, 4)).toBe(4);
    expect(barBeats(6, 8)).toBe(3);
    expect(barBeats(2, 2)).toBe(4);
  });

  it('keeps the menu and the lookup table aligned', () => {
    // An AudioMaterial's enum shows the names and its graph looks up the beats by
    // index. If these ever fall out of step every synced effect silently
    // plays the wrong note length.
    expect(COMMON_DIVISION_NAMES.length).toBe(COMMON_DIVISION_BEATS.length);
    COMMON_DIVISION_NAMES.forEach((name, i) => {
      expect(COMMON_DIVISION_BEATS[i]).toBe(SYNC_DIVISIONS[name]);
    });
  });
});

describe('transportAt', () => {
  it('advances beats with the audio clock while rolling', () => {
    const anchor = { atTime: 10, beats: 4, bpm: 120, playing: true, beatsPerBar: 4 };
    // 120 bpm is two beats a second.
    expect(transportAt(anchor, 11).beats).toBeCloseTo(6, 9);
    expect(transportAt(anchor, 12.5).beats).toBeCloseTo(9, 9);
  });

  it('carries beatUnit through to the snapshot', () => {
    const anchor = { atTime: 10, beats: 4, bpm: 120, playing: true, beatsPerBar: 6, beatUnit: 8 };
    expect(transportAt(anchor, 11).beatUnit).toBe(8);
  });

  it('holds position when the transport is stopped', () => {
    const anchor = { atTime: 10, beats: 4, bpm: 120, playing: false, beatsPerBar: 4 };
    expect(transportAt(anchor, 99).beats).toBe(4);
  });

  it('holds at the anchor before the anchor time', () => {
    // The audible origin is deliberately a little in the future. Until it
    // arrives, the position is the one the anchor names.
    const anchor = { atTime: 10, beats: 4, bpm: 120, playing: true, beatsPerBar: 4 };
    expect(transportAt(anchor, 9.5).beats).toBe(4);
  });

  it('advances a sub-range by exactly its sample offset', () => {
    const snapshot = { beats: 0, bpm: 120, playing: true, beatsPerBar: 4 };
    expect(advanceTransport(snapshot, SR, SR).beats).toBeCloseTo(2, 9);
    expect(advanceTransport(snapshot, 0, SR).beats).toBe(0);
    expect(advanceTransport({ ...snapshot, playing: false }, SR, SR).beats).toBe(0);
  });
});

describe('transport nodes', () => {
  it('reports tempo and playing state', () => {
    expect(renderGraph(probe(() => transport.bpm()), 4, { bpm: 90 })[0]).toBe(90);
    expect(renderGraph(probe(() => transport.playing()), 4, { playing: true })[0]).toBe(1);
    expect(renderGraph(probe(() => transport.playing()), 4, { playing: false })[0]).toBe(0);
  });

  it('advances beats within a block, sample by sample', () => {
    const out = renderGraph(probe(() => transport.beats()), SR, { bpm: 120, beats: 0 });
    expect(out[0]).toBe(0);
    // One second at 120 bpm is two beats.
    expect(out[SR - 1]).toBeCloseTo(2, 3);
  });

  it('does not advance while stopped', () => {
    const out = renderGraph(probe(() => transport.beats()), 512, { beats: 3, playing: false });
    expect(out[0]).toBe(3);
    expect(out[511]).toBe(3);
  });

  it('reports bars using the time signature', () => {
    const four = renderGraph(probe(() => transport.bars()), 4, { beats: 8, beatsPerBar: 4 });
    const three = renderGraph(probe(() => transport.bars()), 4, { beats: 8, beatsPerBar: 3 });
    expect(four[0]).toBeCloseTo(2, 6);
    // Rendered into a Float32Array, so single precision is the ceiling here.
    expect(three[0]).toBeCloseTo(8 / 3, 6);
  });

  it('counts 6/8 bars as three quarter notes', () => {
    const sixEight = renderGraph(probe(() => transport.bars()), 4, {
      beats: 3,
      beatsPerBar: 6,
      beatUnit: 8,
    });
    expect(sixEight[0]).toBeCloseTo(1, 6);
  });

  it('reports the time signature numbers', () => {
    expect(renderGraph(probe(() => transport.beatsPerBar()), 4, { beatsPerBar: 6 })[0]).toBe(6);
    expect(renderGraph(probe(() => transport.beatUnit()), 4, { beatUnit: 8 })[0]).toBe(8);
    expect(renderGraph(probe(() => transport.beatUnit()), 4)[0]).toBe(4);
  });

  it('converts a note length to seconds at the current tempo', () => {
    // A quarter note at 120 bpm is half a second; at 60 bpm it is one.
    expect(renderGraph(probe(() => transport.seconds(1)), 4, { bpm: 120 })[0]).toBeCloseTo(0.5, 9);
    expect(renderGraph(probe(() => transport.seconds(1)), 4, { bpm: 60 })[0]).toBeCloseTo(1, 9);
    expect(renderGraph(probe(() => transport.seconds(0.75)), 4, { bpm: 120 })[0]).toBeCloseTo(
      0.375,
      9,
    );
  });

  it('ramps 0 to 1 within a division and resets at the boundary', () => {
    // One quarter note at 120 bpm is half a second: 24000 samples.
    const out = renderGraph(probe(() => transport.phase(1)), SR, { bpm: 120, beats: 0 });
    expect(out[0]).toBe(0);
    expect(out[12000]).toBeCloseTo(0.5, 3);
    expect(out[23999]).toBeGreaterThan(0.99);
    expect(out[24000]).toBeLessThan(0.01);
  });

  it('is phase-locked to the timeline, not to when rendering started', () => {
    // Starting mid-song must give the phase that song position has, which is
    // the whole difference between a synced LFO and a free-running one.
    const atZero = renderGraph(probe(() => transport.phase(1)), 4, { beats: 0 });
    const atBeatFive = renderGraph(probe(() => transport.phase(1)), 4, { beats: 5 });
    const midDivision = renderGraph(probe(() => transport.phase(1)), 4, { beats: 5.25 });
    expect(atZero[0]).toBe(0);
    expect(atBeatFive[0]).toBeCloseTo(0, 9);
    expect(midDivision[0]).toBeCloseTo(0.25, 9);
  });

  it('pulses once per division, on exactly one sample', () => {
    const out = renderGraph(probe(() => transport.pulse(1)), SR, { bpm: 120, beats: 0 });
    const hits: number[] = [];
    out.forEach((value, i) => {
      if (value !== 0) hits.push(i);
    });
    // Beat zero is a boundary, so the first sample pulses, then again half a
    // second later at 120 bpm. The next one lands at sample 48000, one past
    // the end of this render.
    expect(hits.length).toBe(2);
    expect(hits[0]).toBe(0);
    expect(hits[1]).toBeCloseTo(24000, -1);
    expect(out[hits[1]!]).toBe(1);
  });

  it('does not pulse while stopped', () => {
    const out = renderGraph(probe(() => transport.pulse(1)), SR, { playing: false });
    expect(out.some((v) => v !== 0)).toBe(false);
  });

  it('looks a division index up in its table', () => {
    const build = (index: number) =>
      renderGraph(
        probe(() => transport.division(uniform(index), { divisions: [4, 1, 0.5] })),
        4,
      )[0];
    expect(build(0)).toBe(4);
    expect(build(1)).toBe(1);
    expect(build(2)).toBe(0.5);
  });

  it('clamps an index past the end of its table rather than reading off it', () => {
    // A project saved against a longer menu must not crash an older build.
    const build = (index: number) =>
      renderGraph(
        probe(() => transport.division(uniform(index), { divisions: [4, 1, 0.5] })),
        4,
      )[0];
    expect(build(99)).toBe(0.5);
    expect(build(-3)).toBe(4);
  });

  it('reads zero for a division of zero rather than dividing by it', () => {
    expect(renderGraph(probe(() => transport.phase(0)), 4)[0]).toBe(0);
    expect(renderGraph(probe(() => transport.pulse(0)), 4)[0]).toBe(0);
  });

  it('defaults to a stopped transport at 120 when nothing publishes one', () => {
    const voice = compileVoice(probe(() => transport.bpm()).graph);
    const state = voice.createState();
    const out = new Float32Array(4);
    voice.renderBlock(state, SR, out);
    expect(out[0]).toBe(120);
  });
});

describe('synced Materials', () => {
  it('names its divisions as a menu, not a number', () => {
    const division = syncedDelayMaterial.params.division!;
    expect(division.kind).toBe('enum');
    expect(syncedDelayMaterial.getOption('division')).toBe('1/8');
  });

  it('turns the chosen division into the right delay time', () => {
    // An eighth at 120 bpm is 0.25s; a dotted eighth is 0.375s.
    const material = new AudioMaterial({
      name: 'Probe',
      channels: 1,
      params: { division: syncedDelayMaterial.params.division! },
      graph: ({ params }) =>
        transport.seconds(transport.division(params.division, { divisions: COMMON_DIVISION_BEATS })),
    });
    const read = (option: string): number => {
      material.setOption('division', option);
      return renderGraph(material, 4, { bpm: 120 })[0]!;
    };
    expect(read('1/8')).toBeCloseTo(0.25, 9);
    expect(read('1/8.')).toBeCloseTo(0.375, 9);
    expect(read('1/4')).toBeCloseTo(0.5, 9);
  });

  it('follows a tempo change without being touched', () => {
    const at = (bpm: number) => renderGraph(syncedRampMaterial, SR, { bpm, beats: 0 });
    const quarterSecond = SR / 4;
    // A quarter note is the division. At 60 bpm a quarter second is a quarter
    // of the way through it; at 120 bpm it is halfway. Nothing was set on the
    // AudioMaterial between these two renders.
    expect(at(60)[quarterSecond]).toBeCloseTo(0.25, 3);
    expect(at(120)[quarterSecond]).toBeCloseTo(0.5, 3);
  });

  it('clocks on the grid', () => {
    const out = renderGraph(syncedClockMaterial, SR, { bpm: 120, beats: 0 });
    expect(out.reduce((sum, v) => sum + v, 0)).toBe(2);
  });

  it('renders identically offline, which is what makes a bounce trustworthy', () => {
    const live = renderGraph(syncedRampMaterial, SR, { bpm: 120, beats: 0 });
    const offline = OfflineRenderer.render(syncedRampMaterial.graph, {
      duration: 1,
      sampleRate: SR,
      params: syncedRampMaterial.snapshotParams(),
      transport: { bpm: 120 },
    });
    expect(offline.samples[0]).toBeCloseTo(live[0]!, 9);
    expect(offline.samples[12000]).toBeCloseTo(live[12000]!, 6);
    expect(offline.samples[SR - 1]).toBeCloseTo(live[SR - 1]!, 6);
  });

  it('renders a synced delay offline at the length the menu says', () => {
    // An impulse, then the same impulse a quarter note later.
    const input = new Float32Array(SR);
    input[0] = 1;
    syncedDelayMaterial.setOption('division', '1/4');
    const { samples } = OfflineRenderer.render(syncedDelayMaterial.graph, {
      duration: 1,
      sampleRate: SR,
      params: syncedDelayMaterial.snapshotParams(),
      inputSignal: input,
      transport: { bpm: 120 },
    });
    // 0.5s at 120 bpm, one delay repeat.
    const echo = samples.slice(SR / 2 - 64, SR / 2 + 64);
    expect(Math.max(...echo.map(Math.abs))).toBeGreaterThan(0.05);
    // Nothing where a half-second delay would not have put anything yet.
    const quiet = samples.slice(1000, 5000);
    expect(Math.max(...quiet.map(Math.abs))).toBeLessThan(1e-6);
  });

  it('holds a control signal still under a stopped transport', () => {
    const out = renderGraph(syncedRampMaterial, 4096, { beats: 1.5, playing: false });
    expect(out.every((v) => v === out[0])).toBe(true);
  });
});

describe('transport in a graph with a delay line', () => {
  it('drives an ordinary delay from a synced time', () => {
    const material = new AudioMaterial({
      name: 'Probe',
      params: { fb: param.range(0, 0.9, { default: 0 }) },
      graph: ({ input, params }) =>
        delay(input, { timeSec: transport.seconds(0.5), feedback: params.fb, mix: 1 }),
    });
    const input = new Float32Array(SR);
    input[0] = 1;
    const { samples } = OfflineRenderer.render(material.graph, {
      duration: 1,
      sampleRate: SR,
      params: material.snapshotParams(),
      inputSignal: input,
      transport: { bpm: 120 },
    });
    // An eighth note at 120 bpm is a quarter second.
    const at = SR / 4;
    expect(Math.max(...samples.slice(at - 64, at + 64).map(Math.abs))).toBeGreaterThan(0.05);
  });
});

describe('a graph under a tempo map', () => {
  it('renders a synced ramp that follows the change offline', () => {
    // 120 bpm for two beats (1s), then 60. The quarter-note ramp wraps twice
    // in the first second and then takes a whole second per wrap.
    const map = new TempoMap([{ atBeat: 2, bpm: 60 }], 120);
    const { samples } = OfflineRenderer.render(syncedRampMaterial.graph, {
      duration: 3,
      sampleRate: SR,
      params: syncedRampMaterial.snapshotParams(),
      transport: { tempoMap: map },
    });
    // Half a beat in at 120 bpm: quarter of the way through the division.
    expect(samples[Math.round(SR * 0.25)]).toBeCloseTo(0.5, 2);
    // Two seconds in is beat 3, which is one beat past the change: back to 0.
    expect(samples[Math.round(SR * 2)]).toBeCloseTo(0, 2);
    // Two and a half seconds is beat 3.5, halfway through the division.
    expect(samples[Math.round(SR * 2.5)]).toBeCloseTo(0.5, 2);
  });

  it('renders identically to the constant path when the map is constant', () => {
    const flat = OfflineRenderer.render(syncedRampMaterial.graph, {
      duration: 1,
      sampleRate: SR,
      params: syncedRampMaterial.snapshotParams(),
      transport: { bpm: 120 },
    });
    const mapped = OfflineRenderer.render(syncedRampMaterial.graph, {
      duration: 1,
      sampleRate: SR,
      params: syncedRampMaterial.snapshotParams(),
      transport: { tempoMap: TempoMap.constant(120) },
    });
    for (const i of [0, 1000, SR / 4, SR / 2, SR - 1]) {
      expect(mapped.samples[Math.round(i)]).toBeCloseTo(flat.samples[Math.round(i)], 5);
    }
  });

  it('reports the tempo at the position, not the base tempo', () => {
    const map = new TempoMap([{ atBeat: 2, bpm: 60 }], 120);
    const probe = new AudioMaterial({ name: 'Bpm', channels: 1, graph: () => transport.bpm() });
    const { samples } = OfflineRenderer.render(probe.graph, {
      duration: 2,
      sampleRate: SR,
      transport: { tempoMap: map },
    });
    expect(samples[0]).toBe(120);
    // Beat 2 falls at exactly one second, so the sample just before it is
    // still the old tempo. Half a second past the change is unambiguous.
    expect(samples[SR - 1]).toBe(120);
    expect(samples[Math.round(SR * 1.5)]).toBe(60);
  });
});
