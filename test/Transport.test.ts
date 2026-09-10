import { describe, expect, it } from 'vitest';
import { Transport } from '../src/Transport';
import { TempoMap } from '../src/TempoMap';
import { SceneNotStartedError } from '../src/errors';
import { Time } from '../src/Time';

function fakeHost(isStarted: boolean) {
  return { isStarted };
}

describe('Transport start-gating', () => {
  it('play/pause/stop all throw SceneNotStartedError while the host is unstarted', () => {
    const transport = new Transport(fakeHost(false));
    expect(() => transport.play()).toThrow(SceneNotStartedError);
    expect(() => transport.pause()).toThrow(SceneNotStartedError);
    expect(() => transport.stop()).toThrow(SceneNotStartedError);
  });

  it('transitions state once the host reports started', () => {
    const transport = new Transport(fakeHost(true));
    expect(transport.state).toBe('stopped');
    transport.play();
    expect(transport.state).toBe('playing');
    transport.pause();
    expect(transport.state).toBe('paused');
    transport.stop();
    expect(transport.state).toBe('stopped');
  });

  it('play is a no-op while already playing', () => {
    let starts = 0;
    const transport = new Transport({
      isStarted: true,
      beginPlayback() {
        starts += 1;
        return { audibleOriginCtx: 0 };
      },
    });
    transport.play();
    transport.play();
    expect(starts).toBe(1);
  });
});

describe('Transport.resolve', () => {
  it('resolves a Time against its own bpm/ppqn, not a global default', () => {
    const transport = new Transport(fakeHost(true));
    transport.bpm = 60;
    transport.ppqn = 24;
    // bar 2 beat 1 tick 0 at 4/4, 60bpm = 4 beats in = 4 seconds
    expect(transport.resolve(Time.bars(2, 1, 0))).toBeCloseTo(4);
  });

  it('two transports with different tempos resolve the same Time differently', () => {
    const fast = new Transport(fakeHost(true));
    fast.bpm = 240;
    const slow = new Transport(fakeHost(true));
    slow.bpm = 60;

    const t = Time.beats(4);
    expect(fast.resolve(t)).toBeCloseTo(1);
    expect(slow.resolve(t)).toBeCloseTo(4);
  });
});

describe('transport anchor', () => {
  function host(clock = { now: 0 }, started = true) {
    return {
      isStarted: started,
      audioClock: () => clock.now,
      beginPlayback: (): { audibleOriginCtx: number } => ({ audibleOriginCtx: clock.now + 0.1 }),
      pausePlayback: () => {},
      stopPlayback: () => {},
    };
  }

  it('reports a stopped transport at the playhead', () => {
    const t = new Transport(host());
    t.bpm = 120;
    t.seek(2);
    const anchor = t.anchor;
    expect(anchor.playing).toBe(false);
    expect(anchor.beats).toBeCloseTo(4, 9);
    expect(anchor.bpm).toBe(120);
  });

  it('anchors to the audible origin, not to the moment play was called', () => {
    // They differ by PDC plus schedule-ahead. Anchoring to "now" would put
    // every synced effect out by exactly that offset.
    const clock = { now: 5 };
    const t = new Transport(host(clock));
    t.seek(1);
    t.play();
    expect(t.anchor.atTime).toBeCloseTo(5.1, 9);
    expect(t.anchor.beats).toBeCloseTo(2, 9);
    expect(t.anchor.playing).toBe(true);
  });

  it('publishes on play, pause, stop, seek and tempo', () => {
    const t = new Transport(host());
    const seen: string[] = [];
    t.onTransportChange((a) => seen.push(a.playing ? 'playing' : 'stopped'));
    t.play();
    t.bpm = 90;
    t.pause();
    t.seek(0);
    t.stop();
    expect(seen).toEqual(['playing', 'playing', 'stopped', 'stopped', 'stopped']);
  });

  it('does not publish when the tempo is set to what it already was', () => {
    const t = new Transport(host());
    let count = 0;
    t.onTransportChange(() => (count += 1));
    t.bpm = 120;
    expect(count).toBe(0);
    t.bpm = 121;
    expect(count).toBe(1);
  });

  it('reads no clock before the scene starts', () => {
    // Asking an unstarted scene for its audio clock throws, and setting a
    // tempo before start() is ordinary.
    const t = new Transport(host({ now: 0 }, false));
    expect(() => {
      t.bpm = 140;
    }).not.toThrow();
    expect(t.anchor.atTime).toBe(0);
  });

  it('stops listening when unsubscribed', () => {
    const t = new Transport(host());
    let count = 0;
    const off = t.onTransportChange(() => (count += 1));
    t.bpm = 130;
    off();
    t.bpm = 140;
    expect(count).toBe(1);
  });
});

describe('transport tempo map', () => {
  function host(clock = { now: 0 }) {
    return {
      isStarted: true,
      audioClock: () => clock.now,
      beginPlayback: (): { audibleOriginCtx: number } => ({ audibleOriginCtx: clock.now }),
      pausePlayback: () => {},
      stopPlayback: () => {},
    };
  }

  it('carries no map by default, and omits it from the time context', () => {
    // `Time.toSeconds` must take the branch it always took, not one that
    // happens to agree.
    const t = new Transport(host());
    expect(t.tempoMap).toBeNull();
    expect('tempoMap' in t.timeContext).toBe(false);
  });

  it('reports beats and tempo through the map', () => {
    const t = new Transport(host());
    t.tempoMap = new TempoMap([{ atBeat: 4, bpm: 60 }], 120);
    t.seek(2);
    expect(t.positionBeats).toBeCloseTo(4, 9);
    expect(t.currentBpm).toBe(60);
    t.seek(1);
    expect(t.positionBeats).toBeCloseTo(2, 9);
    expect(t.currentBpm).toBe(120);
  });

  it('takes its base tempo from a map it is given', () => {
    const t = new Transport(host());
    t.tempoMap = new TempoMap([{ atBeat: 4, bpm: 60 }], 90);
    expect(t.bpm).toBe(90);
  });

  it('rebases a map when the base tempo is set, keeping the changes', () => {
    // "The song is now slower" when the song already has a tempo change in it.
    const t = new Transport(host());
    t.tempoMap = new TempoMap([{ atBeat: 4, bpm: 60 }], 120);
    t.bpm = 60;
    expect(t.tempoMap.baseBpm).toBe(60);
    expect(t.tempoMap.changes).toEqual([{ atBeat: 4, bpm: 60, curve: 'jump' }]);
  });

  it('puts every upcoming change on the anchor, in audio-clock time', () => {
    const clock = { now: 10 };
    const t = new Transport(host(clock));
    t.tempoMap = new TempoMap([{ atBeat: 4, bpm: 60 }], 120);
    t.play();
    const anchor = t.anchor;
    expect(anchor.beats).toBe(0);
    expect(anchor.bpm).toBe(120);
    // Beat 4 at 120 bpm is two seconds after the origin.
    expect(anchor.changes?.length).toBe(1);
    expect(anchor.changes?.[0]?.atTime).toBeCloseTo(12, 9);
    expect(anchor.changes?.[0]?.beats).toBe(4);
    expect(anchor.changes?.[0]?.bpm).toBe(60);
  });

  it('drops a change the playhead has already passed', () => {
    const t = new Transport(host());
    t.tempoMap = new TempoMap([{ atBeat: 4, bpm: 60 }], 120);
    t.seek(3);
    expect(t.anchor.changes).toBeUndefined();
    expect(t.anchor.bpm).toBe(60);
  });

  it('carries no changes at all without a map', () => {
    const t = new Transport(host());
    expect(t.anchor.changes).toBeUndefined();
  });
});
