import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planStreamWork, segmentAt, type StreamSegment } from '../../src/stream/fetchPlan';
import { StreamClip, type StreamSource } from '../../src/stream/StreamClip';
import { holdWhileBuffering } from '../../src/stream/bufferingGuard';
import { planScenePlayback } from '../../src/playback/plan';
import { ScenePlayback } from '../../src/playback/ScenePlayback';
import { AudioScene } from '../../src/AudioScene';
import { Track } from '../../src/graph/Track';
import { Bus } from '../../src/graph/Bus';
import { Time } from '../../src/Time';

const sixes = (n: number): StreamSegment[] => Array.from({ length: n }, (_, i) => ({ start: i * 6, duration: 6 }));

function work(positionSec: number, appended: number[], inFlight: number[] = [], extra = {}) {
  return planStreamWork({
    segments: sixes(40),
    positionSec,
    appended: new Set(appended),
    inFlight: new Set(inFlight),
    aheadSec: 24,
    behindSec: 20,
    ...extra,
  });
}

describe('stream fetch plan', () => {
  it('finds the segment under a position, clamped', () => {
    const s = sixes(5);
    expect(segmentAt(s, 0)).toBe(0);
    expect(segmentAt(s, 5.99)).toBe(0);
    expect(segmentAt(s, 6)).toBe(1);
    expect(segmentAt(s, 999)).toBe(4);
    expect(segmentAt(s, -1)).toBe(0);
    expect(segmentAt([], 3)).toBe(-1);
  });

  it('fetches the current segment, then fills forward to the ahead window and stops', () => {
    expect(work(0, [])).toEqual({ kind: 'fetch', index: 0 });
    expect(work(0, [0])).toEqual({ kind: 'fetch', index: 1 });
    expect(work(0, [0, 1, 2, 3])).toEqual({ kind: 'idle' });
    expect(work(13, [0, 1, 2, 3])).toEqual({ kind: 'fetch', index: 4 });
  });

  it('fetches one at a time and respects a hold on fetching', () => {
    expect(work(0, [0], [1])).toEqual({ kind: 'idle' });
    expect(work(0, [], [], { allowFetch: false })).toEqual({ kind: 'idle' });
  });

  it('after a seek, fetches the new position before anything else', () => {
    expect(work(120, [0, 1, 2, 3])).toEqual({ kind: 'fetch', index: 20 });
  });

  it('evicts what is far behind or far ahead, one contiguous run at a time', () => {
    expect(work(120, [0, 1, 2, 20, 21])).toEqual({ kind: 'evict', start: 0, end: 18, indices: [0, 1, 2] });
    // A seek back leaves the old window far ahead.
    expect(work(0, [0, 1, 2, 3, 30, 31])).toEqual({ kind: 'evict', start: 180, end: 192, indices: [30, 31] });
  });
});

function fakeSource(durationSec = 60) {
  const calls: Array<[string, ...number[]]> = [];
  const listeners = new Set<(stalled: boolean) => void>();
  let media = 0;
  let ahead = 0;
  const node = { connect: vi.fn(), disconnect: vi.fn() };
  const source: StreamSource & { stall(v: boolean): void; setMedia(n: number): void; setAhead(n: number): void } = {
    durationSec,
    outputFor: () => node,
    start: (when, offset) => {
      calls.push(['start', when, offset]);
      media = offset;
    },
    stop: () => calls.push(['stop']),
    mediaTimeSec: () => media,
    bufferedAheadSec: () => ahead,
    onStall(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stall: (v) => listeners.forEach((fn) => fn(v)),
    setMedia: (n) => {
      media = n;
    },
    setAhead: (n) => {
      ahead = n;
    },
  };
  return { source, calls, node };
}

describe('StreamClip in the playback plan', () => {
  const timeContext = { bpm: 120, ppqn: 24, beatsPerBar: 4, beatUnit: 4 };

  it('starts a stream from where the playhead falls inside it', () => {
    const track = new Track({ name: 'song' });
    const { source } = fakeSource(60);
    const clip = new StreamClip({ source, gainDb: -6 });
    track.addStream(clip, { at: Time.seconds(2) });
    const plan = (playheadSec: number) =>
      planScenePlayback({ tracks: [track], master: new Bus(), timeContext, resolveOffsetSec: () => 0, playheadSec, sampleRate: 48000 });

    expect(plan(0).streamJobs).toEqual([
      expect.objectContaining({ clipId: clip.id, whenSec: 2, fileOffsetSec: 0, fileDurationSec: 60, gainDb: -6 }),
    ]);
    expect(plan(32).streamJobs).toEqual([expect.objectContaining({ whenSec: 0, fileOffsetSec: 30, fileDurationSec: 30 })]);
    expect(plan(62).streamJobs).toEqual([]);
    expect(plan(0).jobs).toEqual([]);
  });

  it('a muted track or master plans no stream', () => {
    const track = new Track({ name: 'song' });
    track.addStream(new StreamClip({ source: fakeSource().source }), { at: Time.seconds(0) });
    track.muted = true;
    const plan = planScenePlayback({ tracks: [track], master: new Bus(), timeContext, resolveOffsetSec: () => 0, playheadSec: 0, sampleRate: 48000 });
    expect(plan.streamJobs).toEqual([]);
  });
});

describe('ScenePlayback with a stream', () => {
  function fakeCtx() {
    const gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const make = (extra: object) => ({ connect: vi.fn(), disconnect: vi.fn(), ...extra });
    const ctx = {
      currentTime: 10,
      sampleRate: 48000,
      destination: make({}),
      createGain: () => {
        const g = make({ gain: { value: 1 } }) as (typeof gains)[number];
        gains.push(g);
        return g;
      },
      createStereoPanner: () => make({ pan: { value: 0 } }),
      createBufferSource: () => make({ buffer: null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn() }),
      createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
    };
    return { ctx, gains };
  }

  it('routes the stream through the track chain and starts it at the shared origin', () => {
    const { ctx, gains } = fakeCtx();
    const track = new Track({ name: 'song' });
    const { source, calls, node } = fakeSource(60);
    const clip = new StreamClip({ source, gainDb: -6 });
    track.addStream(clip, { at: Time.seconds(0) });
    const plan = planScenePlayback({
      tracks: [track],
      master: new Bus(),
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4, beatUnit: 4 },
      resolveOffsetSec: () => 0,
      playheadSec: 5,
      sampleRate: 48000,
    });
    const playback = new ScenePlayback();
    const start = playback.start(ctx as never, [track], new Bus(), plan, new Map());

    const streamGain = gains.find((g) => node.connect.mock.calls.some(([to]) => to === g))!;
    expect(streamGain.gain.value).toBeCloseTo(Math.pow(10, -6 / 20));
    // The stream gain feeds the track's clip-gain entry, like a clip source.
    expect(streamGain.connect).toHaveBeenCalledWith(start.clipGainTargets.get(track.id));
    expect(calls).toEqual([['start', start.originCtx, 5]]);

    playback.stop();
    expect(calls.at(-1)).toEqual(['stop']);
    expect(node.disconnect).toHaveBeenCalledWith(streamGain);
  });
});

describe('holdWhileBuffering', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function startedScene() {
    let now = 0;
    const scene = new AudioScene({
      createContext: () =>
        ({
          get currentTime() {
            return now;
          },
          sampleRate: 48000,
          state: 'running',
          resume: async () => {},
          close: async () => {},
        }) as never,
    });
    await scene.start();
    return { scene, advance: (s: number) => (now += s) };
  }

  it('pauses the transport at the heard position on a stall and plays again once buffered', async () => {
    const { scene, advance } = await startedScene();
    const { source } = fakeSource(120);
    const changes: boolean[] = [];
    const guard = holdWhileBuffering(scene, source, { timelineOffsetSec: 1, onChange: (b) => changes.push(b) });
    scene.transport.play();
    advance(10);
    source.setMedia(8.5);
    source.stall(true);

    expect(scene.transport.state).toBe('paused');
    expect(scene.transport.position).toBeCloseTo(9.5);
    expect(guard.buffering).toBe(true);

    source.setAhead(1);
    vi.advanceTimersByTime(400);
    expect(scene.transport.state).toBe('paused');

    source.setAhead(3);
    vi.advanceTimersByTime(200);
    expect(scene.transport.state).toBe('playing');
    expect(guard.buffering).toBe(false);
    expect(changes).toEqual([true, false]);
    guard.dispose();
  });

  it('does not resume after the user pauses, and ignores stalls while stopped', async () => {
    const { scene } = await startedScene();
    const { source } = fakeSource(120);
    let wantPlay = true;
    const guard = holdWhileBuffering(scene, source, { shouldResume: () => wantPlay });
    source.stall(true);
    expect(guard.buffering).toBe(false);

    scene.transport.play();
    source.stall(true);
    wantPlay = false;
    source.setAhead(30);
    vi.advanceTimersByTime(1000);
    expect(scene.transport.state).toBe('paused');
    expect(guard.buffering).toBe(false);
    guard.dispose();
  });

  it('near the end, the rest of the song is enough to resume', async () => {
    const { scene } = await startedScene();
    const { source } = fakeSource(10);
    const guard = holdWhileBuffering(scene, source, { resumeAheadSec: 3 });
    scene.transport.play();
    source.setMedia(9);
    source.stall(true);
    source.setAhead(1);
    vi.advanceTimersByTime(200);
    expect(scene.transport.state).toBe('playing');
    guard.dispose();
  });
});
