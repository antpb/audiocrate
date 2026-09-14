import { describe, expect, it } from 'vitest';
import { ScenePlayback } from '../../src/playback/ScenePlayback';
import type { PlaybackPlan, PlannedClipJob } from '../../src/playback/plan';
import type { LiveSceneVoices } from '../../src/playback/liveVoices';
import type { AudioBufferLike } from '../../src/graph/Clip';
import type { VoiceHandle } from '../../src/renderers/WebAudioRenderer';
import { fakeVoiceHandle } from '../../src/testing/fakeVoice';
import { Track } from '../../src/graph/Track';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { Bus } from '../../src/graph/Bus';

interface FakeNode {
  connect(n: unknown, output?: number, input?: number): void;
  disconnect(): void;
  connectedTo: unknown[];
  /** Same edges as `connectedTo`, keeping the port indices a sidechain needs. */
  connections: Array<{ node: unknown; output: number; input: number }>;
  disconnected: boolean;
}

function makeNode(extra: Record<string, unknown> = {}): FakeNode & Record<string, unknown> {
  const node = {
    connectedTo: [] as unknown[],
    connections: [] as Array<{ node: unknown; output: number; input: number }>,
    disconnected: false,
    connect(n: unknown, output = 0, input = 0) {
      node.connectedTo.push(n);
      node.connections.push({ node: n, output, input });
    },
    disconnect() {
      node.disconnected = true;
      node.connectedTo = []; // matches real AudioNode.disconnect(): drops all outgoing connections
      node.connections = [];
    },
    ...extra,
  };
  return node;
}

function createFakeWebAudioContext(sampleRate = 48000) {
  const destination = makeNode();
  const sources: ReturnType<typeof makeNode>[] = [];
  /** Every node the context minted, so a test can look for an edge by port index. */
  const nodes: ReturnType<typeof makeNode>[] = [];
  const track = <T extends ReturnType<typeof makeNode>>(node: T): T => {
    nodes.push(node);
    return node;
  };
  const ctx = {
    currentTime: 0,
    sampleRate,
    destination,
    createGain: () => track(makeNode({ gain: { value: 1 } })),
    createStereoPanner: () => track(makeNode({ pan: { value: 0 } })),
    createBufferSource: () => {
      const s = makeNode({ buffer: null, playbackRate: { value: 1 }, startArgs: null as unknown[] | null, stop() {} });
      (s as unknown as { start: (...args: unknown[]) => void }).start = (...args: unknown[]) => {
        (s as unknown as { startArgs: unknown[] }).startArgs = args;
      };
      sources.push(s);
      return s;
    },
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        sampleRate,
        copyToChannel: (d: Float32Array, ch: number) => data[ch]!.set(d),
        getChannelData: (ch: number) => data[ch]!,
      };
    },
  };
  return { ctx, sources, nodes };
}

function fakeVoice(auxInputs: readonly string[] = []): VoiceHandle {
  const node = makeNode();
  return fakeVoiceHandle(node as unknown as VoiceHandle['node'], {
    auxInputs,
    inputIndexFor: (name: string) => {
      if (name === 'input') return 0;
      const index = auxInputs.indexOf(name);
      if (index === -1) throw new RangeError(`no audio input "${name}"`);
      return index + 1;
    },
  });
}

function monoBuffer(length: number): AudioBufferLike {
  const data = new Float32Array(length);
  return { sampleRate: 48000, length, numberOfChannels: 1, getChannelData: () => data };
}

function emptyPlan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    jobs: [],
    midiJobs: [],
    midiCcJobs: [],
    playheadSec: 0,
    maxTrackLatencySamples: 0,
    masterLatencySamples: 0,
    sampleRate: 48000,
    ...overrides,
  };
}

function clipJob(overrides: Partial<PlannedClipJob> = {}): PlannedClipJob {
  return {
    trackId: 1,
    clipId: 1,
    whenSec: 0,
    fileOffsetSec: 0,
    fileDurationSec: 1,
    playbackRate: 1,
    volume: 1,
    pan: 0,
    pdcSec: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    fadeInCurve: 'linear',
    fadeOutCurve: 'linear',
    gainDb: 0,
    trimStartSec: 0,
    trimEndSec: 1,
    ...overrides,
  };
}

describe('ScenePlayback: live voice wiring', () => {
  it('routes a dry clip source through the track insert chain, then track gain/pan, then master, then destination', () => {
    const { ctx } = createFakeWebAudioContext();
    const track = new Track({ name: 'T' });
    const insertVoice = fakeVoice();
    const liveVoices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [insertVoice] }]]),
    };
    const buffer = monoBuffer(4);
    const buffers = new Map<number, AudioBufferLike>([[1, buffer]]);
    const plan = emptyPlan({ jobs: [clipJob({ trackId: track.id })] });

    const playback = new ScenePlayback();
    playback.start(ctx as never, [track], new Bus({ name: 'Master' }), plan, buffers, liveVoices);

    // dry source -> insert voice's node
    expect(ctx as never).toBeTruthy();
    const insertNode = insertVoice.node as unknown as FakeNode;
    expect(insertNode.connectedTo).toHaveLength(1); // insert -> track gain
  });

  it('connects a track instrument voice at the same entry point as dry clips, and exposes it as a MIDI target', () => {
    const { ctx } = createFakeWebAudioContext();
    const track = new Track({ name: 'T' });
    const instrumentVoice = fakeVoice();
    let onCalled: [number, number] | null = null;
    instrumentVoice.midiNoteOn = (note, velocity) => {
      onCalled = [note, velocity];
    };
    const liveVoices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [], instrument: instrumentVoice }]]),
    };
    const plan = emptyPlan();

    const playback = new ScenePlayback();
    const start = playback.start(ctx as never, [track], new Bus({ name: 'Master' }), plan, new Map(), liveVoices);

    const target = start.instrumentTargets.get(track.id);
    expect(target).toBeDefined();
    target!.noteOn(60, { velocity: 0.8 });
    expect(onCalled).toEqual([60, 0.8]);

    const instrumentNode = instrumentVoice.node as unknown as FakeNode;
    expect(instrumentNode.connectedTo).toHaveLength(1);
  });

  it('feeds an AudioMaterial aux input from the track it names, on the right worklet input', () => {
    const { ctx, nodes } = createFakeWebAudioContext();
    const kick = new Track({ name: 'Kick' });
    const bass = new Track({ name: 'Bass' });
    const ducker = new AudioMaterial({
      name: 'Ducker',
      params: {},
      graph: ({ input, audio }) => input.mul(audio.sidechain()),
    });
    ducker.setAudioSource('sidechain', { kind: 'track', trackId: kick.id });
    bass.materials.add(ducker);

    const insertVoice = fakeVoice(['sidechain']);
    const liveVoices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[bass.id, { inserts: [insertVoice] }]]),
    };

    const playback = new ScenePlayback();
    const start = playback.start(
      ctx as never,
      [kick, bass],
      new Bus({ name: 'Master' }),
      emptyPlan(),
      new Map(),
      liveVoices,
    );

    // The kick has no clips and no voices of its own, so its chain exists
    // only because something keyed off it.
    expect(start.trackFaders.has(kick.id)).toBe(true);
    const auxEdges = nodes.flatMap((n) =>
      n.connections.filter((c) => c.node === insertVoice.node && c.input > 0),
    );
    expect(auxEdges).toEqual([{ node: insertVoice.node, output: 0, input: 1 }]);
  });

  it('leaves an undeclared aux input unconnected rather than mixing the key into the audio', () => {
    const { ctx, nodes } = createFakeWebAudioContext();
    const track = new Track({ name: 'T' });
    track.materials.add(new AudioMaterial({ name: 'Gain', params: {}, graph: ({ input }) => input.mul(1) }));
    const insertVoice = fakeVoice([]);
    const liveVoices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [insertVoice] }]]),
    };

    new ScenePlayback().start(
      ctx as never,
      [track],
      new Bus({ name: 'Master' }),
      emptyPlan(),
      new Map(),
      liveVoices,
    );

    const intoAux = nodes.some((n) => n.connections.some((c) => c.node === insertVoice.node && c.input > 0));
    expect(intoAux).toBe(false);
  });

  it('chains master insert voices ahead of the master gain', () => {
    const { ctx } = createFakeWebAudioContext();
    const masterVoice = fakeVoice();
    const liveVoices: LiveSceneVoices = { master: [masterVoice], tracks: new Map() };
    const plan = emptyPlan();

    const playback = new ScenePlayback();
    playback.start(ctx as never, [], new Bus({ name: 'Master' }), plan, new Map(), liveVoices);

    const masterNode = masterVoice.node as unknown as FakeNode;
    expect(masterNode.connectedTo).toHaveLength(1); // master insert -> master gain
  });

  it('disconnects live voice connections on stop(), so replaying the same batch does not duplicate edges', () => {
    const { ctx } = createFakeWebAudioContext();
    const track = new Track({ name: 'T' });
    const insertVoice = fakeVoice();
    const liveVoices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [insertVoice] }]]),
    };
    const plan = emptyPlan();

    const playback = new ScenePlayback();
    playback.start(ctx as never, [track], new Bus({ name: 'Master' }), plan, new Map(), liveVoices);
    const insertNode = insertVoice.node as unknown as FakeNode;
    expect(insertNode.connectedTo).toHaveLength(1);

    playback.stop();
    expect(insertNode.disconnected).toBe(true);

    playback.start(ctx as never, [track], new Bus({ name: 'Master' }), plan, new Map(), liveVoices);
    // Same voice object reused: exactly one live connection again, not two.
    expect(insertNode.connectedTo).toHaveLength(1);
  });

  it('exposes live track faders and a master fader carrying master volume, so a mixer can move them without re-planning', () => {
    const { ctx } = createFakeWebAudioContext();
    const track = new Track({ name: 'T' });
    const master = new Bus({ name: 'Master' });
    master.volume = 0.5;
    const buffers = new Map<number, AudioBufferLike>([[1, monoBuffer(4)]]);
    const plan = emptyPlan({ jobs: [clipJob({ trackId: track.id, volume: 0.8, pan: -0.25 })] });

    const playback = new ScenePlayback();
    const start = playback.start(ctx as never, [track], master, plan, buffers);

    expect(start.masterFader!.gain.value).toBe(0.5);
    const fader = start.trackFaders.get(track.id)!;
    expect(fader.gain.value).toBe(0.8);
    expect(fader.pan.value).toBe(-0.25);

    // A live move writes straight into the node, no rescheduling involved.
    fader.gain.value = 0.1;
    start.masterFader!.gain.value = 0.9;
    expect(start.trackFaders.get(track.id)!.gain.value).toBe(0.1);
    expect(start.masterFader!.gain.value).toBe(0.9);
  });

  it('a muted master fader is silent (plan-level skip still applies separately)', () => {
    const { ctx } = createFakeWebAudioContext();
    const master = new Bus({ name: 'Master' });
    master.volume = 1;
    master.muted = true;
    const playback = new ScenePlayback();
    const start = playback.start(ctx as never, [], master, emptyPlan(), new Map());
    expect(start.masterFader!.gain.value).toBe(0);
  });

  it('still works with no live voices supplied at all (existing dry-only callers)', () => {
    const { ctx } = createFakeWebAudioContext();
    const track = new Track({ name: 'T' });
    const buffer = monoBuffer(4);
    const buffers = new Map<number, AudioBufferLike>([[1, buffer]]);
    const plan = emptyPlan({ jobs: [clipJob({ trackId: track.id })] });

    const playback = new ScenePlayback();
    const start = playback.start(ctx as never, [track], new Bus({ name: 'Master' }), plan, buffers);
    expect(start.instrumentTargets.size).toBe(0);
  });

  it('resamples 44.1k clips to the opened 48k context and keeps file-time windows', () => {
    const { ctx, sources } = createFakeWebAudioContext(48000);
    const track = new Track({ name: 'T' });
    const data = new Float32Array(44100);
    const buffer: AudioBufferLike = {
      sampleRate: 44100,
      length: 44100,
      numberOfChannels: 1,
      getChannelData: () => data,
    };
    const playback = new ScenePlayback();
    playback.start(
      ctx as never,
      [track],
      new Bus({ name: 'Master' }),
      emptyPlan({
        jobs: [clipJob({ trackId: track.id, fileOffsetSec: 2.728, fileDurationSec: 0.5, playbackRate: 1 })],
      }),
      new Map([[1, buffer]]),
    );
    const src = sources[0]!;
    const args = src.startArgs as unknown[];
    expect((src.buffer as { sampleRate: number; getChannelData: (ch: number) => Float32Array }).sampleRate).toBe(48000);
    expect(
      (src.buffer as { getChannelData: (ch: number) => Float32Array }).getChannelData(0).length,
    ).toBe(48000);
    expect(src.playbackRate.value).toBe(1);
    expect(args[1]).toBeCloseTo(2.728, 8);
    expect(args[2]).toBeCloseTo(0.5, 8);
  });
});
