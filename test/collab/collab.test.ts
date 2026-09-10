/**
 * Two peers, a deliberately bad link, and the properties that have to hold
 * anyway. The transport is injected, so all of this runs in one process with
 * no network and no server, which is the point of injecting it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CRATE_PROTOCOL_VERSION,
  MESSAGE,
  StateCodec,
  cratePeerCodec,
  dequantize16,
  peerHash,
  quantize16,
} from '../../src/collab/protocol';
import { SnapshotBuffer, blendRecords, lerp, recordBlender } from '../../src/collab/interpolation';
import { SessionClock, sessionHost } from '../../src/collab/SessionClock';
import { LoopbackHub } from '../../src/collab/CollabTransport';
import { SceneSync } from '../../src/collab/SceneSync';
import { attachAudioScene } from '../../src/collab/attachScene';
import { compareEdits, decodeEdit, encodeEdit } from '../../src/collab/edits';
import { AudioScene } from '../../src/AudioScene';
import { Track } from '../../src/graph/Track';
import { Clip } from '../../src/graph/Clip';
import { Time } from '../../src/Time';
import type { AudioContextLike } from '../../src/AudioContextLike';

function session(latency = 0) {
  const timers: Array<() => void> = [];
  const hub = new LoopbackHub({ latency, random: () => 0.5, schedule: (fn) => fn() });
  let clockValue = 0;
  let wallValue = 1000;
  const options = () => ({
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearInterval: () => {},
    now: () => clockValue,
    wallNow: () => wallValue,
  });
  const a = new SceneSync(hub.join('peer-a'), options());
  wallValue += 1;
  const b = new SceneSync(hub.join('peer-b'), options());
  return {
    a,
    b,
    hub,
    tick: () => timers.forEach((fn) => fn()),
    advance: (seconds: number) => {
      clockValue += seconds;
    },
    advanceWall: (seconds: number) => {
      wallValue += seconds;
    },
    connect: (id: string) => new SceneSync(hub.join(id), options()),
  };
}

describe('presence-mask protocol', () => {
  it('sends only the fields that changed', () => {
    const all = cratePeerCodec.encode('peer-a', { gain: 1, pan: 0, position: 12, playing: 1, bpm: 120, track: 3 });
    const one = cratePeerCodec.encode('peer-a', { gain: 0.5 });
    // Header, mask, one quantized field.
    expect(one.length).toBe(4 + cratePeerCodec.maskByteLength + 2);
    expect(one.length).toBeLessThan(all.length);
  });

  it('round-trips every field kind', () => {
    const bytes = cratePeerCodec.encode('peer-a', { gain: 1.5, pan: -0.5, position: 12.25, playing: 1, bpm: 128 });
    const decoded = cratePeerCodec.decode(bytes)!;
    expect(decoded.version).toBe(CRATE_PROTOCOL_VERSION);
    expect(decoded.type).toBe(MESSAGE.peerState);
    expect(decoded.peerHash).toBe(peerHash('peer-a'));
    expect(decoded.fields.gain).toBeCloseTo(1.5, 4);
    expect(decoded.fields.pan).toBeCloseTo(-0.5, 4);
    // Position is f32 because it is time; the rest can afford to be quantized.
    expect(decoded.fields.position).toBe(12.25);
    expect(decoded.fields.playing).toBe(1);
    expect(decoded.fields.bpm).toBeCloseTo(128, 2);
  });

  it('omits a field entirely rather than sending a default for it', () => {
    const decoded = cratePeerCodec.decode(cratePeerCodec.encode('peer-a', { pan: 0.25 }))!;
    expect(Object.keys(decoded.fields)).toEqual(['pan']);
    // Absent, not zero. A receiver has to be able to tell "unchanged" from
    // "changed to zero", or a peer that never touches its fader silently
    // mutes itself on every other peer's screen.
    expect(decoded.fields.gain).toBeUndefined();
  });

  it('quantizes within the resolution it claims, and clamps rather than wraps', () => {
    const step = 2 / 65535;
    for (const value of [0, 0.5, 1, 1.999]) {
      expect(dequantize16(quantize16(value, 0, 2), 0, 2)).toBeCloseTo(value, Math.ceil(-Math.log10(step)) - 1);
    }
    // Out of range must not become the opposite extreme.
    expect(dequantize16(quantize16(99, 0, 2), 0, 2)).toBeCloseTo(2, 6);
    expect(dequantize16(quantize16(-99, 0, 2), 0, 2)).toBeCloseTo(0, 6);
  });

  it('lets a newer sender and an older decoder talk', () => {
    // The append-only property. New fields take higher bits and serialize
    // last, so an old decoder reads the prefix it knows and the rest falls
    // off the end.
    const newer = new StateCodec([
      { name: 'gain', bit: 0, encoding: { kind: 'q16', min: 0, max: 2 } },
      { name: 'pan', bit: 1, encoding: { kind: 'q16', min: -1, max: 1 } },
      { name: 'tilt', bit: 6, encoding: { kind: 'f32' } },
    ]);
    const older = new StateCodec([
      { name: 'gain', bit: 0, encoding: { kind: 'q16', min: 0, max: 2 } },
      { name: 'pan', bit: 1, encoding: { kind: 'q16', min: -1, max: 1 } },
    ]);

    const decoded = older.decode(newer.encode('p', { gain: 1, pan: 0.5, tilt: 42 }))!;
    expect(decoded.fields.gain).toBeCloseTo(1, 4);
    expect(decoded.fields.pan).toBeCloseTo(0.5, 4);
    expect(decoded.fields.tilt).toBeUndefined();
  });

  it('lets an older sender and a newer decoder talk', () => {
    const newer = new StateCodec([
      { name: 'gain', bit: 0, encoding: { kind: 'q16', min: 0, max: 2 } },
      { name: 'tilt', bit: 6, encoding: { kind: 'f32' } },
    ]);
    const older = new StateCodec([{ name: 'gain', bit: 0, encoding: { kind: 'q16', min: 0, max: 2 } }]);
    const decoded = newer.decode(older.encode('p', { gain: 0.75 }))!;
    expect(decoded.fields.gain).toBeCloseTo(0.75, 4);
    expect(decoded.fields.tilt).toBeUndefined();
  });

  it('refuses a packet from another protocol version instead of misreading it', () => {
    const bytes = cratePeerCodec.encode('p', { gain: 1 });
    bytes[0] = 99;
    expect(cratePeerCodec.decode(bytes)).toBeNull();
  });

  it('survives a truncated packet, because a peer-to-peer link produces them', () => {
    const bytes = cratePeerCodec.encode('p', { gain: 1, pan: 0.5, position: 3 });
    expect(cratePeerCodec.decode(bytes.slice(0, 6))).not.toBeNull();
    expect(cratePeerCodec.decode(bytes.slice(0, 2))).toBeNull();
  });

  it('refuses to reuse a presence bit', () => {
    expect(
      () =>
        new StateCodec([
          { name: 'a', bit: 3, encoding: { kind: 'u8' } },
          { name: 'b', bit: 3, encoding: { kind: 'u8' } },
        ]),
    ).toThrow(RangeError);
  });
});

describe('snapshot interpolation', () => {
  it('renders behind the present, between the two snapshots that bracket it', () => {
    const buffer = new SnapshotBuffer(lerp, { renderDelay: 0.1 });
    buffer.push(1, 0);
    buffer.push(2, 10);
    // now = 2.1 renders at 2.0... but with delay 0.1 that is time 2.0.
    expect(buffer.sample(2.1)).toBeCloseTo(10, 6);
    expect(buffer.sample(1.6)).toBeCloseTo(5, 6);
  });

  it('accepts an out-of-order arrival in its right place', () => {
    // A packet that took the scenic route still describes a real moment.
    const buffer = new SnapshotBuffer(lerp, { renderDelay: 0 });
    buffer.push(1, 0);
    buffer.push(3, 20);
    buffer.push(2, 10);
    expect(buffer.sample(2.5)).toBeCloseTo(15, 6);
  });

  it('extrapolates briefly, then holds still', () => {
    const buffer = new SnapshotBuffer(lerp, { renderDelay: 0, maxExtrapolation: 0.2 });
    buffer.push(1, 0);
    buffer.push(2, 10);
    // Inside the window: keep moving along the last trajectory.
    expect(buffer.sample(2.1)).toBeCloseTo(11, 6);
    // Past it: freeze rather than slide off the end of the range.
    expect(buffer.sample(5)).toBeCloseTo(10, 6);
  });

  it('drops the oldest snapshots rather than growing without bound', () => {
    const buffer = new SnapshotBuffer(lerp, { capacity: 4 });
    for (let i = 0; i < 20; i++) buffer.push(i, i);
    expect(buffer.size).toBe(4);
    expect(buffer.latestTime).toBe(19);
  });

  it('blends records field by field and keeps one only the newer side has', () => {
    expect(blendRecords({ gain: 0, pan: 0 }, { gain: 1, pan: 1, bpm: 120 }, 0.5)).toEqual({
      gain: 0.5,
      pan: 0.5,
      bpm: 120,
    });
  });
});

describe('session clock', () => {
  it('finds the offset between two clocks from one clean round trip', () => {
    const clock = new SessionClock();
    // Remote runs 5 seconds ahead; each leg takes 10 ms.
    clock.addSample({ t0: 0, t1: 5.01, t2: 5.01, t3: 0.02 });
    expect(clock.synchronized).toBe(true);
    expect(clock.offset).toBeCloseTo(5, 6);
    expect(clock.roundTrip).toBeCloseTo(0.02, 6);
    expect(clock.toSession(1)).toBeCloseTo(6, 6);
    expect(clock.toLocal(6)).toBeCloseTo(1, 6);
  });

  it('prefers the lowest round trip over the average of a jittery batch', () => {
    // The formula assumes both legs took equally long. A slow, asymmetric
    // sample is wrong, and averaging it with good ones spreads the error
    // instead of discarding it. This is the whole reason for lowest-RTT.
    const clock = new SessionClock();
    clock.addSample({ t0: 0, t1: 5.2, t2: 5.2, t3: 0.5 }); // 500 ms, asymmetric
    clock.addSample({ t0: 1, t1: 6.001, t2: 6.001, t3: 1.002 }); // 2 ms, clean
    clock.addSample({ t0: 2, t1: 7.3, t2: 7.3, t3: 2.9 }); // 900 ms, worse
    expect(clock.roundTrip).toBeCloseTo(0.002, 6);
    expect(clock.offset).toBeCloseTo(5, 3);
  });

  it('reports a rate of exactly 1 until the baseline is long enough to measure one', () => {
    // Fitting drift from a few seconds of samples measures jitter and calls
    // it a crystal difference.
    const clock = new SessionClock({ minRateBaseline: 20 });
    clock.addSample({ t0: 0, t1: 1.001, t2: 1.001, t3: 0.002 });
    clock.addSample({ t0: 1, t1: 2.001, t2: 2.001, t3: 1.002 });
    expect(clock.rate).toBe(1);
  });

  it('tracks a real crystal difference over a long baseline', () => {
    // 50 ppm is an ordinary disagreement between two devices, and about 3 ms
    // of drift a minute: inaudible for a second, unusable for a take.
    const ppm = 50e-6;
    const clock = new SessionClock({ minRateBaseline: 20 });
    for (let local = 0; local <= 120; local += 10) {
      const remote = 5 + local * (1 + ppm);
      clock.addSample({ t0: local, t1: remote + 0.001, t2: remote + 0.001, t3: local + 0.002 });
    }
    expect(clock.rate).toBeCloseTo(1 + ppm, 7);
    // Without the rate fit, a two-minute session would be out by ~6 ms.
    expect(clock.toSession(120)).toBeCloseTo(5 + 120 * (1 + ppm), 4);
  });

  it('rejects a sample whose arithmetic says it arrived before it left', () => {
    const clock = new SessionClock();
    expect(clock.addSample({ t0: 1, t1: 0, t2: 5, t3: 1.001 })).toBe(false);
    expect(clock.synchronized).toBe(false);
  });

  it('gives the timeline to whoever has been here longest', () => {
    // Not lowest id. A late joiner whose id happens to sort first must not
    // take the session away from the person who started it, which is what
    // the first version of this did.
    expect(
      sessionHost([
        { id: 'zoe', joinedAt: 100 },
        { id: 'adam', joinedAt: 500 },
        { id: 'mia', joinedAt: 900 },
      ]),
    ).toBe('zoe');
  });

  it('breaks a tie by id, so every peer computes the same answer', () => {
    const room = [
      { id: 'mia', joinedAt: 100 },
      { id: 'adam', joinedAt: 100 },
      { id: 'zoe', joinedAt: 100 },
    ];
    expect(sessionHost(room)).toBe('adam');
    expect(sessionHost([...room].reverse())).toBe('adam');
  });

  it('has no host in an empty room', () => {
    expect(sessionHost([])).toBeNull();
  });
});

describe('two peers over a loopback link', () => {
  it('carries one peer is fader to the other', () => {
    const { a, b, tick } = session();
    a.set('gain', 0.75);
    tick();
    expect(b.stateOf('peer-a')!.gain).toBeCloseTo(0.75, 3);
  });

  it('sends nothing when nothing changed', () => {
    const { a, hub, tick } = session();
    const deliver = vi.spyOn(hub, 'deliver');
    tick();
    const afterIdle = deliver.mock.calls.filter((call) => call[0] === 'peer-a' && call[1][1] === 1).length;
    a.set('gain', 0.5);
    tick();
    const afterChange = deliver.mock.calls.filter((call) => call[0] === 'peer-a' && call[1][1] === 1).length;
    expect(afterIdle).toBe(0);
    expect(afterChange).toBe(1);
  });

  it('does not queue into a link that is down', () => {
    // A client queueing into a dead connection looks exactly like a working one.
    const { a, b, hub, tick } = session();
    const transport = hub.join('peer-c');
    const c = new SceneSync(transport, { now: () => 0, setInterval: () => 0, clearInterval: () => {} });
    transport.setConnected(false);
    c.set('gain', 0.9);
    c.flush();
    tick();
    expect(a.latestOf('peer-c')).toBeNull();
    expect(b.latestOf('peer-c')).toBeNull();
    c.close();
    transport.close();
  });

  it('agrees on a host once peers have heard from each other', () => {
    const { a, b, tick } = session();
    // Before any heartbeat each peer believes it is alone, and a peer that is
    // alone is the authority. Correct, not a bug: there is nothing yet to
    // defer to, and a peer must not stall waiting for a room it may be the
    // only member of.
    expect(a.isHost).toBe(true);
    expect(b.isHost).toBe(true);

    tick();
    tick();

    // The earlier arrival keeps the timeline, and both peers agree without
    // an election round trip.
    expect(a.hostPeerId).toBe('peer-a');
    expect(b.hostPeerId).toBe('peer-a');
    expect(a.isHost).toBe(true);
    expect(b.isHost).toBe(false);
  });

  it('drops a silent peer out of the election rather than letting it hold the timeline', () => {
    // The failure this prevents: a host disappears in a way that never
    // reaches the transport, and the room keeps deferring to somebody gone.
    const { b, tick, advanceWall } = session();
    tick();
    tick();
    expect(b.hostPeerId).toBe('peer-a');

    advanceWall(9); // past the eight second timeout
    expect(b.hostPeerId).toBe('peer-b');
    expect(b.isHost).toBe(true);
  });

  it('synchronises clocks through the heartbeat round trip', () => {
    const { a, b, tick } = session();
    // Two ticks: the probe out, the reply back.
    tick();
    tick();
    expect(a.clockFor('peer-b')?.synchronized).toBe(true);
    expect(b.clockFor('peer-a')?.synchronized).toBe(true);
  });

  it('forgets a peer that leaves rather than holding its state forever', () => {
    const { a, hub, tick } = session();
    const transport = hub.join('peer-d');
    const d = new SceneSync(transport, { now: () => 0, setInterval: () => 0, clearInterval: () => {} });
    d.set('gain', 0.4);
    d.flush();
    tick();
    expect(a.latestOf('peer-d')).not.toBeNull();

    // Closing the transport is what removes the peer. `SceneSync` does not
    // own the transport it was handed, so closing the sync alone must not
    // silently disconnect somebody else's link.
    d.close();
    transport.close();
    expect(a.latestOf('peer-d')).toBeNull();
    expect(a.stateOf('peer-d')).toBeNull();
  });

  it('keeps a field a peer set earlier when a later packet carries only one', () => {
    // The presence mask means a packet is a delta. A receiver that replaced
    // its whole record would blank every field the sender did not resend,
    // and one that merged into the delayed render would lose anything set
    // more than a render delay ago.
    const { a, b, tick, advance } = session();
    a.set('gain', 0.8);
    a.set('pan', -0.5);
    tick();
    advance(0.5);
    a.set('gain', 0.2);
    tick();
    advance(0.5);
    tick();

    const state = b.stateOf('peer-a')!;
    expect(state.gain).toBeCloseTo(0.2, 3);
    expect(state.pan).toBeCloseTo(-0.5, 3);
    expect(b.latestOf('peer-a')!.pan).toBeCloseTo(-0.5, 3);
  });

  it('reads the newest value undelayed, for anything that must not lag', () => {
    const { a, b, tick } = session();
    a.set('playing', 1);
    tick();
    // `stateOf` is deliberately behind; `latestOf` is not. A transport
    // command must not arrive a jitter buffer late.
    expect(b.latestOf('peer-a')!.playing).toBe(1);
  });

  it('does not read a blob packet as peer state', () => {
    const { a, b, hub } = session();
    hub.deliver('peer-a', new Uint8Array([1, 4, 0, 0, 1, 2, 3]));
    expect(b.latestOf('peer-a')).toBeNull();
    a.close();
    b.close();
  });
});

describe('fields that must not be interpolated', () => {
  it('steps a flag rather than blending it to a value that means neither', () => {
    const stepped = new StateCodec([
      { name: 'gain', bit: 0, encoding: { kind: 'q16', min: 0, max: 2 } },
      { name: 'playing', bit: 1, encoding: { kind: 'u8' }, interpolate: 'step' },
    ]);
    const blend = recordBlender(stepped.stepFields);
    // A gain halfway between two snapshots is halfway. A play flag is not.
    const early = blend({ gain: 0, playing: 0 }, { gain: 1, playing: 1 }, 0.4);
    expect(early.gain).toBeCloseTo(0.4, 6);
    expect(early.playing).toBe(0);

    const late = blend({ gain: 0, playing: 0 }, { gain: 1, playing: 1 }, 0.6);
    expect(late.gain).toBeCloseTo(0.6, 6);
    expect(late.playing).toBe(1);
  });

  it('declares the crate fields that step', () => {
    expect(cratePeerCodec.stepFields).toEqual(['playing', 'track']);
  });

  it('never shows a peer half-playing', () => {
    const hub = new LoopbackHub({ schedule: (fn) => fn() });
    let clockValue = 0;
    const timers: Array<() => void> = [];
    const options = {
      setInterval: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearInterval: () => {},
      now: () => clockValue,
    };
    const a = new SceneSync(hub.join('peer-a'), options);
    const b = new SceneSync(hub.join('peer-b'), options);
    const tick = () => timers.forEach((fn) => fn());

    a.set('playing', 0);
    tick();
    clockValue += 0.5;
    a.set('playing', 1);
    tick();

    // Read all the way across the transition; it must be 0 or 1 throughout.
    for (let t = 0; t <= 1; t += 0.05) {
      clockValue += 0.05;
      const state = b.stateOf('peer-a');
      if (state?.playing !== undefined) expect([0, 1]).toContain(state.playing);
    }
    a.close();
    b.close();
  });
});

function fakeContext(): AudioContextLike {
  return {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
    resume: async () => {},
    close: async () => {},
  } as AudioContextLike;
}

function silentBuffer(): { sampleRate: number; length: number; numberOfChannels: number; getChannelData: (channel: number) => Float32Array } {
  const data = new Float32Array(8);
  return {
    sampleRate: 48000,
    length: 8,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

describe('discrete edits', () => {
  it('round-trips an edit and keeps the author, not the relayer', () => {
    const bytes = encodeEdit({
      seq: 7,
      time: 1.25,
      peerId: 'peer-a',
      target: 'master',
      kind: 'mixer',
      value: { volume: 0.4, pan: 0, muted: 0 },
    });
    expect(bytes[0]).toBe(CRATE_PROTOCOL_VERSION);
    expect(bytes[1]).toBe(MESSAGE.edit);
    const decoded = decodeEdit(bytes, 'peer-relay')!;
    expect(decoded.peerId).toBe('peer-a');
    expect(decoded.seq).toBe(7);
    expect(decoded.time).toBe(1.25);
    expect(decoded.target).toBe('master');
    expect(decoded.kind).toBe('mixer');
    expect(decoded.value.volume).toBe(0.4);
  });

  it('ranks later time first, then greater peer id, then seq', () => {
    const early = { seq: 9, time: 1, peerId: 'peer-z', target: 'x', kind: 'k', value: {} };
    const late = { seq: 1, time: 2, peerId: 'peer-a', target: 'x', kind: 'k', value: {} };
    expect(compareEdits(late, early)).toBeGreaterThan(0);
    const a = { seq: 1, time: 1, peerId: 'peer-a', target: 'x', kind: 'k', value: {} };
    const b = { seq: 1, time: 1, peerId: 'peer-b', target: 'x', kind: 'k', value: {} };
    expect(compareEdits(b, a)).toBeGreaterThan(0);
    const first = { seq: 1, time: 1, peerId: 'peer-a', target: 'x', kind: 'k', value: {} };
    const second = { seq: 2, time: 1, peerId: 'peer-a', target: 'x', kind: 'k', value: {} };
    expect(compareEdits(second, first)).toBeGreaterThan(0);
  });

  it('carries an edit without it being read as peer state', () => {
    const { a, b } = session();
    const received: string[] = [];
    b.onEdit((edit) => received.push(edit.target));
    a.sendEdit({ target: 'master', kind: 'mixer', value: { volume: 0.5 } });
    expect(received).toEqual(['master']);
    expect(b.latestOf('peer-a')).toBeNull();
    a.close();
    b.close();
  });

  it('keeps the later write and reports the discarded one', () => {
    const { a, b, advance } = session();
    const conflicts: Array<{ kept: string; discarded: string }> = [];
    a.onConflict((conflict) =>
      conflicts.push({ kept: conflict.kept.peerId, discarded: conflict.discarded.peerId }),
    );
    a.sendEdit({ target: 'master', kind: 'mixer', value: { volume: 0.2 } });
    advance(0.05);
    b.sendEdit({ target: 'master', kind: 'mixer', value: { volume: 0.8 } });
    expect(conflicts).toEqual([{ kept: 'peer-b', discarded: 'peer-a' }]);
    a.close();
    b.close();
  });

  it('orders discrete edits by wall time, not the audio clock', () => {
    const hub = new LoopbackHub({ schedule: (fn) => fn() });
    let wall = 1000;
    const timers = { setInterval: () => 0, clearInterval: () => {} };
    const a = new SceneSync(hub.join('peer-a'), { ...timers, now: () => 50, wallNow: () => wall });
    const b = new SceneSync(hub.join('peer-b'), { ...timers, now: () => 1, wallNow: () => wall });
    const actions: string[] = [];
    a.onEdit((edit) => {
      if (edit.target === 'transport') actions.push(String(edit.value.action));
    });
    a.sendEdit({ target: 'transport', kind: 'transport', value: { action: 'playing' } });
    wall += 2;
    b.sendEdit({ target: 'transport', kind: 'transport', value: { action: 'stopped' } });
    expect(actions).toEqual(['playing', 'stopped']);
    a.close();
    b.close();
  });

  it('replays accepted edits to a late joiner on first clock contact', () => {
    const { a, connect, tick } = session();
    a.sendEdit({ target: 'master', kind: 'mixer', value: { volume: 0.3, pan: -0.25, muted: 0 } });
    const late = connect('peer-c');
    const received: Array<{ target: string; volume: unknown }> = [];
    late.onEdit((edit) => received.push({ target: edit.target, volume: edit.value.volume }));
    tick();
    expect(received).toEqual([{ target: 'master', volume: 0.3 }]);
    a.close();
    late.close();
  });
});

describe('attachAudioScene', () => {
  it('follows play on the remote scene', async () => {
    const { a, b } = session();
    const sceneA = new AudioScene({ createContext: () => fakeContext() });
    const sceneB = new AudioScene({ createContext: () => fakeContext() });
    await sceneA.start();
    await sceneB.start();
    const offA = attachAudioScene(a, sceneA);
    const offB = attachAudioScene(b, sceneB);
    sceneA.transport.play();
    expect(sceneB.transport.state).toBe('playing');
    sceneA.transport.pause();
    expect(sceneB.transport.state).toBe('paused');
    offA();
    offB();
    a.close();
    b.close();
  });

  it('follows a master mixer write on the next tick', async () => {
    const { a, b, tick } = session();
    const sceneA = new AudioScene({ createContext: () => fakeContext() });
    const sceneB = new AudioScene({ createContext: () => fakeContext() });
    await sceneA.start();
    await sceneB.start();
    const offA = attachAudioScene(a, sceneA);
    const offB = attachAudioScene(b, sceneB);
    sceneA.master.volume = 0.4;
    sceneA.master.pan = -0.5;
    sceneA.master.muted = true;
    tick();
    expect(sceneB.master.volume).toBe(0.4);
    expect(sceneB.master.pan).toBe(-0.5);
    expect(sceneB.master.muted).toBe(true);
    offA();
    offB();
    a.close();
    b.close();
  });

  it('applies a clip edit by name when ids differ', async () => {
    const { a, b } = session();
    const sceneA = new AudioScene({ createContext: () => fakeContext() });
    const sceneB = new AudioScene({ createContext: () => fakeContext() });
    sceneA.addTrack(new Track({ name: 'lead' })).addClip(new Clip({ buffer: silentBuffer(), name: 'hook' }), {
      at: Time.seconds(0),
    });
    sceneB.addTrack(new Track({ name: 'lead' })).addClip(new Clip({ buffer: silentBuffer(), name: 'hook' }), {
      at: Time.seconds(0),
    });
    await sceneA.start();
    await sceneB.start();
    const offA = attachAudioScene(a, sceneA);
    const offB = attachAudioScene(b, sceneB);
    sceneA.tracks[0]!.clips[0]!.clip.gainDb = -6;
    a.sendEdit({
      target: 'clip:hook',
      kind: 'clip',
      value: { name: 'hook', gainDb: -6, fadeInSec: 0.01, fadeOutSec: 0.02 },
    });
    const remote = sceneB.tracks[0]!.clips[0]!.clip;
    expect(remote.gainDb).toBe(-6);
    expect(remote.fadeInSec).toBe(0.01);
    expect(remote.fadeOutSec).toBe(0.02);
    offA();
    offB();
    a.close();
    b.close();
  });
});
