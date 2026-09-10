import { describe, expect, it } from 'vitest';
import { planScenePlayback } from '../../src/playback/plan';
import { Track } from '../../src/graph/Track';
import { Bus } from '../../src/graph/Bus';
import { Clip } from '../../src/graph/Clip';
import { MidiClip } from '../../src/graph/MidiClip';
import { Time } from '../../src/Time';
import { TempoMap } from '../../src/TempoMap';
import { pdcStartDelaySec, pdcAudibleOriginSec } from '../../src/host/pdc';
import { transportAt } from '../../src/asl/transportNodes';
import { Transport } from '../../src/Transport';

/**
 * The property this file exists to defend: **a tempo map changes what second
 * a musical position falls on, and nothing else.**
 *
 * Clips line up because one origin is captured after the graph is built and
 * every track is offset from it by its own compensation value. That is
 * arithmetic in seconds and a tempo map is not allowed anywhere near it. A
 * scene that never sets a map must plan byte-identically to before maps
 * existed, and a scene that does set one must still get its PDC offsets from
 * the same place.
 */

const SAMPLE_RATE = 48000;

function buffer(seconds = 1) {
  return {
    length: Math.round(SAMPLE_RATE * seconds),
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData: () => new Float32Array(Math.round(SAMPLE_RATE * seconds)),
  };
}

function sceneWith(latencies: readonly number[]) {
  const tracks = latencies.map((latency, i) => {
    const track = new Track({ name: `t${i}` });
    // The compensation value each track is offset by. Stubbed rather than
    // computed from Materials, because what is under test is the offsetting,
    // not where the number came from.
    Object.defineProperty(track, 'latencySamples', { value: latency, configurable: true });
    track.addClip(new Clip({ buffer: buffer() as never }), { at: Time.bars(2, 1, 0) });
    return track;
  });
  return { tracks, master: new Bus({ name: 'master' }) };
}

function plan(tracks: Track[], master: Bus, timeContext: Record<string, unknown>) {
  return planScenePlayback({
    tracks,
    master,
    playheadSec: 0,
    sampleRate: SAMPLE_RATE,
    timeContext: timeContext as never,
    resolveOffsetSec: (track, clipIndex) =>
      track.clips[clipIndex]!.at.toSeconds(timeContext as never),
  });
}

describe('tempo map and clip alignment', () => {
  const constantCtx = { bpm: 120, ppqn: 24, beatsPerBar: 4 };

  it('plans identically with no map and with a constant map', () => {
    // Not "close". The same plan, so upgrading cannot move anybody's clips.
    const a = sceneWith([0, 512, 128]);
    const b = sceneWith([0, 512, 128]);
    const withoutMap = plan(a.tracks, a.master, constantCtx);
    const withMap = plan(b.tracks, b.master, {
      ...constantCtx,
      tempoMap: TempoMap.constant(120),
    });
    // Guard: two empty arrays are equal, and that would prove nothing.
    expect(withoutMap.jobs.length).toBe(3);
    expect(withMap.jobs.map((j) => j.whenSec)).toEqual(withoutMap.jobs.map((j) => j.whenSec));
    expect(withMap.jobs.map((j) => j.pdcSec)).toEqual(withoutMap.jobs.map((j) => j.pdcSec));
  });

  it('keeps each track compensation offset when a tempo map is set', () => {
    const { tracks, master } = sceneWith([0, 512, 128]);
    const mapped = plan(tracks, master, {
      ...constantCtx,
      tempoMap: new TempoMap([{ atBeat: 4, bpm: 60 }], 120),
    });
    // The compensation value is a function of latency and sample rate only.
    // A tempo map must not appear in it.
    const maxLatency = 512;
    for (const [index, track] of tracks.entries()) {
      const expected = pdcStartDelaySec(track.latencySamples, maxLatency, SAMPLE_RATE);
      expect(mapped.jobs[index]!.pdcSec).toBeCloseTo(expected, 12);
    }
    // The wettest track waits for nothing; the driest waits the longest.
    expect(mapped.jobs[1]!.pdcSec).toBe(0);
    expect(mapped.jobs[0]!.pdcSec).toBeCloseTo(512 / SAMPLE_RATE, 12);
  });

  it('leaves the audible origin alone', () => {
    // The origin is latency over sample rate. It has no musical component and
    // must not acquire one.
    expect(pdcAudibleOriginSec(512, 128, SAMPLE_RATE)).toBeCloseTo(640 / SAMPLE_RATE, 12);
  });

  it('moves a musical clip position and only that', () => {
    const { tracks, master } = sceneWith([0, 512, 128]);
    // Bar 2 beat 1 is beat 4. At a flat 120 that is 2s.
    const flat = plan(tracks, master, constantCtx);
    expect(flat.jobs[0]!.whenSec).toBeCloseTo(2, 9);

    const slower = sceneWith([0, 512, 128]);
    const mapped = plan(slower.tracks, slower.master, {
      ...constantCtx,
      tempoMap: new TempoMap([{ atBeat: 2, bpm: 60 }], 120),
    });
    // Two beats at 120 then two at 60: one second plus two.
    expect(mapped.jobs[0]!.whenSec).toBeCloseTo(3, 9);
    // Every track still starts at the same musical moment, offset only by
    // its own compensation.
    const starts = new Set(mapped.jobs.map((j) => j.whenSec));
    expect(starts.size).toBe(1);
  });

  it('does not move a clip placed in seconds', () => {
    const track = new Track({ name: 'seconds' });
    track.addClip(new Clip({ buffer: buffer() as never }), { at: Time.seconds(1.5) });
    const master = new Bus({ name: 'master' });
    const mapped = plan([track], master, {
      ...constantCtx,
      tempoMap: new TempoMap([{ atBeat: 1, bpm: 30 }], 120),
    });
    expect(mapped.jobs[0]!.whenSec).toBe(1.5);
  });
});

describe('tempo map and MIDI inside a clip', () => {
  const constantCtx = { bpm: 120, ppqn: 24, beatsPerBar: 4 };

  function midiScene() {
    const track = new Track({ name: 'midi' });
    track.addMidiClip(
      new MidiClip({
        notes: [
          { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 1 },
          { pitch: 62, startBeat: 4, durationBeats: 1, velocity: 1 },
        ],
      }),
      { at: Time.seconds(0) },
    );
    return { track, master: new Bus({ name: 'master' }) };
  }

  it('places notes identically with no map and with a constant map', () => {
    const a = midiScene();
    const b = midiScene();
    const flat = plan([a.track], a.master, constantCtx);
    const mapped = plan([b.track], b.master, {
      ...constantCtx,
      tempoMap: TempoMap.constant(120),
    });
    expect(flat.midiJobs.length).toBe(2);
    expect(mapped.midiJobs.map((j) => j.onSec)).toEqual(flat.midiJobs.map((j) => j.onSec));
    expect(mapped.midiJobs.map((j) => j.offSec)).toEqual(flat.midiJobs.map((j) => j.offSec));
  });

  it('resolves a note against its absolute position, not one tempo', () => {
    const { track, master } = midiScene();
    // Slower from beat 2 onward. The note at beat 4 is two beats past it.
    const mapped = plan([track], master, {
      ...constantCtx,
      tempoMap: new TempoMap([{ atBeat: 2, bpm: 60 }], 120),
    });
    expect(mapped.midiJobs[0]!.onSec).toBeCloseTo(0, 9);
    expect(mapped.midiJobs[1]!.onSec).toBeCloseTo(3, 9);
  });

  it('lengthens a note held across a tempo drop', () => {
    const track = new Track({ name: 'held' });
    track.addMidiClip(
      new MidiClip({ notes: [{ pitch: 60, startBeat: 0, durationBeats: 4, velocity: 1 }] }),
      { at: Time.seconds(0) },
    );
    const mapped = plan([track], new Bus({ name: 'master' }), {
      ...constantCtx,
      tempoMap: new TempoMap([{ atBeat: 2, bpm: 60 }], 120),
    });
    // Four beats: two at 120 (1s) then two at 60 (2s). A whole note is a
    // whole note, and it takes longer when the song slows down.
    expect(mapped.midiJobs[0]!.offSec).toBeCloseTo(3, 9);
  });
});

describe('tempo changes reaching the audio thread', () => {
  it('follows a change on the sample it lands on', () => {
    // 120 bpm from clock time 10, dropping to 60 one second later.
    const anchor = {
      atTime: 10,
      beats: 0,
      bpm: 120,
      playing: true,
      beatsPerBar: 4,
      changes: [{ atTime: 11, beats: 2, bpm: 60 }],
    };
    expect(transportAt(anchor, 10).beats).toBeCloseTo(0, 9);
    expect(transportAt(anchor, 10.5).beats).toBeCloseTo(1, 9);
    // At the seam, both sides agree.
    expect(transportAt(anchor, 11).beats).toBeCloseTo(2, 9);
    expect(transportAt(anchor, 11).bpm).toBe(60);
    // Past it, at the new tempo.
    expect(transportAt(anchor, 12).beats).toBeCloseTo(3, 9);
  });

  it('walks several changes in order', () => {
    const anchor = {
      atTime: 0,
      beats: 0,
      bpm: 120,
      playing: true,
      beatsPerBar: 4,
      changes: [
        { atTime: 2, beats: 4, bpm: 60 },
        { atTime: 6, beats: 8, bpm: 240 },
      ],
    };
    expect(transportAt(anchor, 6).beats).toBeCloseTo(8, 9);
    expect(transportAt(anchor, 7).beats).toBeCloseTo(12, 9);
    expect(transportAt(anchor, 7).bpm).toBe(240);
  });

  it('does not step over a change while stopped', () => {
    // A paused transport holds where it is. Crossing a tempo change it never
    // reached would move the position under a stopped playhead.
    const anchor = {
      atTime: 0,
      beats: 1,
      bpm: 120,
      playing: false,
      beatsPerBar: 4,
      changes: [{ atTime: 2, beats: 4, bpm: 60 }],
    };
    expect(transportAt(anchor, 99).beats).toBe(1);
    expect(transportAt(anchor, 99).bpm).toBe(120);
  });

  it('is unchanged when there are no changes', () => {
    const anchor = { atTime: 10, beats: 4, bpm: 120, playing: true, beatsPerBar: 4 };
    expect(transportAt(anchor, 11).beats).toBeCloseTo(6, 9);
  });
});

describe('tempo ramps reaching the audio thread', () => {
  it('follows a ramp by integrating, not by stepping', () => {
    // 60 bpm ramping to 120 over four beats, starting at clock time 0.
    const slope = 15; // BPM per beat
    const anchor = {
      atTime: 0,
      beats: 0,
      bpm: 60,
      playing: true,
      beatsPerBar: 4,
      slope,
    };
    // The map's own answer for the same moment.
    const map = new TempoMap(
      [
        { atBeat: 0, bpm: 60, curve: 'ramp' as const },
        { atBeat: 4, bpm: 120 },
      ],
      60,
    );
    for (const seconds of [0, 0.5, 1, 2, map.secondsAtBeat(4)]) {
      expect(transportAt(anchor, seconds).beats).toBeCloseTo(map.beatAtSeconds(seconds), 9);
      expect(transportAt(anchor, seconds).bpm).toBeCloseTo(map.bpmAtSeconds(seconds), 9);
    }
  });

  it('agrees with the map across a ramp into a hold', () => {
    const map = new TempoMap(
      [
        { atBeat: 4, bpm: 60, curve: 'ramp' as const },
        { atBeat: 8, bpm: 120 },
      ],
      120,
    );
    const anchor = {
      atTime: 0,
      beats: 0,
      bpm: 120,
      playing: true,
      beatsPerBar: 4,
      changes: map.segmentsFromBeat(0).map((seg) => ({
        atTime: seg.atSeconds,
        beats: seg.atBeat,
        bpm: seg.bpm,
        ...(seg.slope !== 0 ? { slope: seg.slope } : {}),
      })),
    };
    for (const seconds of [0, 1, 2, 3, 4, 5, 6, 8]) {
      expect(transportAt(anchor, seconds).beats).toBeCloseTo(map.beatAtSeconds(seconds), 6);
    }
  });

  it('takes the unchanged path when nothing ramps', () => {
    const withZero = { atTime: 0, beats: 0, bpm: 120, playing: true, beatsPerBar: 4, slope: 0 };
    const without = { atTime: 0, beats: 0, bpm: 120, playing: true, beatsPerBar: 4 };
    expect(transportAt(withZero, 1).beats).toBe(transportAt(without, 1).beats);
    expect(transportAt(without, 1).beats).toBe(2);
  });

  it('holds a ramping anchor while stopped', () => {
    const anchor = {
      atTime: 0,
      beats: 1,
      bpm: 60,
      playing: false,
      beatsPerBar: 4,
      slope: 15,
    };
    expect(transportAt(anchor, 99).beats).toBe(1);
    expect(transportAt(anchor, 99).bpm).toBe(60);
  });
});

describe('starting inside a ramp', () => {
  function host(clock: { now: number }) {
    return {
      isStarted: true,
      audioClock: () => clock.now,
      beginPlayback: (): { audibleOriginCtx: number } => ({ audibleOriginCtx: clock.now }),
      pausePlayback: () => {},
      stopPlayback: () => {},
    };
  }

  it('anchors to the slope of the span the playhead is inside', () => {
    // Without this a song resumed mid-accelerando would hold whatever tempo
    // it happened to be at when play was pressed.
    const clock = { now: 0 };
    const t = new Transport(host(clock));
    t.tempoMap = new TempoMap(
      [
        { atBeat: 0, bpm: 60, curve: 'ramp' as const },
        { atBeat: 8, bpm: 120 },
      ],
      60,
    );
    const halfway = t.tempoMap.secondsAtBeat(4);
    t.seek(halfway);
    t.play();
    const anchor = t.anchor;
    expect(anchor.beats).toBeCloseTo(4, 9);
    expect(anchor.bpm).toBeCloseTo(90, 9);
    expect(anchor.slope).toBeCloseTo(7.5, 9);
    // And it keeps agreeing with the map from there.
    expect(transportAt(anchor, 1).beats).toBeCloseTo(t.tempoMap.beatAtSeconds(halfway + 1), 6);
  });

  it('carries no slope when the playhead is in a constant span', () => {
    const clock = { now: 0 };
    const t = new Transport(host(clock));
    t.tempoMap = new TempoMap([{ atBeat: 4, bpm: 60 }], 120);
    t.play();
    expect(t.anchor.slope).toBeUndefined();
  });
});
