import { describe, expect, it } from 'vitest';
import { AudioScene } from '../../src/AudioScene';
import { AutomationLane } from '../../src/automation/AutomationLane';
import { Easing } from '../../src/automation/Easing';
import { Clip, type AudioBufferLike } from '../../src/graph/Clip';
import { Track } from '../../src/graph/Track';
import { PDC_SCHEDULE_AHEAD_SEC } from '../../src/host/pdc';

/** A convolver-sized partition: the shape a latency-reporting insert has. */
const IR_LATENCY_SAMPLES = 512;
import { Time } from '../../src/Time';
import { MidiClip } from '../../src/graph/MidiClip';
import { planScenePlayback } from '../../src/playback/plan';

function fakeBuffer(length = 48000, sampleRate = 48000): AudioBufferLike {
  return {
    sampleRate,
    length,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(length),
  };
}

function fakeContext(currentTime = 0) {
  return {
    currentTime,
    sampleRate: 48000,
    state: 'running' as const,
    async resume() {},
    async close() {},
  };
}

describe('planScenePlayback', () => {
  it('skips muted tracks and past clips, keeps the in-progress window', () => {
    const live = new Track({ name: 'live' });
    const muted = new Track({ name: 'muted' });
    muted.muted = true;
    live.addClip(new Clip({ buffer: fakeBuffer(48000) }), { at: Time.seconds(0) });
    live.addClip(new Clip({ buffer: fakeBuffer(48000) }), { at: Time.seconds(2) });
    muted.addClip(new Clip({ buffer: fakeBuffer(48000) }), { at: Time.seconds(0) });

    const scene = new AudioScene({ createContext: () => fakeContext() });
    scene.addTrack(live);
    scene.addTrack(muted);

    const plan = planScenePlayback({
      tracks: scene.tracks,
      master: scene.master,
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4 },
      resolveOffsetSec: (track, i) => track.clips[i]!.at.toSeconds({ bpm: 120, ppqn: 24, beatsPerBar: 4 }),
      playheadSec: 0.25,
      sampleRate: 48000,
    });

    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]!.whenSec).toBe(0);
    expect(plan.jobs[0]!.fileOffsetSec).toBeCloseTo(0.25);
    expect(plan.jobs[1]!.whenSec).toBeCloseTo(1.75);
  });

  it('delays the dry track so an IR track emerges with it', () => {
    const dry = new Track({ name: 'dry' });
    const wet = new Track({ name: 'wet' });
    wet.latencySamples = IR_LATENCY_SAMPLES;
    dry.addClip(new Clip({ buffer: fakeBuffer() }), { at: Time.seconds(0) });
    wet.addClip(new Clip({ buffer: fakeBuffer() }), { at: Time.seconds(0) });

    const plan = planScenePlayback({
      tracks: [dry, wet],
      master: new AudioScene({ createContext: () => fakeContext() }).master,
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4 },
      resolveOffsetSec: () => 0,
      playheadSec: 0,
      sampleRate: 48000,
    });

    const dryJob = plan.jobs.find((j) => j.trackId === dry.id)!;
    const wetJob = plan.jobs.find((j) => j.trackId === wet.id)!;
    expect(wetJob.pdcSec).toBe(0);
    expect(dryJob.pdcSec).toBeCloseTo(IR_LATENCY_SAMPLES / 48000);
  });

  it('chases a gain lane at the playhead', () => {
    const track = new Track();
    track.automate(
      'gain',
      new AutomationLane({
        shape: Easing.linear,
        from: 0,
        to: 1,
        range: { start: Time.seconds(0), end: Time.seconds(2) },
      }),
    );
    track.addClip(new Clip({ buffer: fakeBuffer(96000) }), { at: Time.seconds(0) });
    const plan = planScenePlayback({
      tracks: [track],
      master: new AudioScene({ createContext: () => fakeContext() }).master,
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4 },
      resolveOffsetSec: () => 0,
      playheadSec: 1,
      sampleRate: 48000,
    });
    expect(plan.jobs[0]!.volume).toBeCloseTo(0.5);
  });

  it('carries clip fades onto the audio job', () => {
    const track = new Track();
    track.addClip(
      new Clip({
        buffer: fakeBuffer(),
        fadeInSec: 0.1,
        fadeOutSec: 0.2,
        fadeInCurve: 'equalPower',
        gainDb: -6,
      }),
      { at: Time.seconds(0) },
    );
    const plan = planScenePlayback({
      tracks: [track],
      master: new AudioScene({ createContext: () => fakeContext() }).master,
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4 },
      resolveOffsetSec: () => 0,
      playheadSec: 0,
      sampleRate: 48000,
    });
    expect(plan.jobs[0]).toMatchObject({
      fadeInSec: 0.1,
      fadeOutSec: 0.2,
      fadeInCurve: 'equalPower',
      gainDb: -6,
    });
  });

  it('plans remaining MIDI notes after the playhead', () => {
    const track = new Track();
    track.addMidiClip(
      new MidiClip({
        notes: [
          { pitch: 60, velocity: 1, startBeat: 0, durationBeats: 1 },
          { pitch: 64, velocity: 0.5, startBeat: 2, durationBeats: 1 },
        ],
      }),
      { at: Time.seconds(0) },
    );
    const plan = planScenePlayback({
      tracks: [track],
      master: new AudioScene({ createContext: () => fakeContext() }).master,
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4 },
      resolveOffsetSec: () => 0,
      playheadSec: 0.25,
      sampleRate: 48000,
    });
    expect(plan.midiJobs).toHaveLength(2);
    expect(plan.midiJobs[0]!.onSec).toBeCloseTo(-0.25);
    expect(plan.midiJobs[0]!.offSec).toBeCloseTo(0.25);
    expect(plan.midiJobs[1]!.pitch).toBe(64);
    expect(plan.midiJobs[1]!.onSec).toBeCloseTo(0.75);
  });

  it('plans clip CC lanes and chases the last value before the playhead', () => {
    const track = new Track();
    track.addMidiClip(
      new MidiClip({
        notes: [],
        ccLanes: [
          {
            cc: 74,
            channel: 0,
            points: [
              { startBeat: 0, value: 10 },
              { startBeat: 1, value: 40 },
              { startBeat: 3, value: 90 },
            ],
          },
        ],
      }),
      { at: Time.seconds(0) },
    );
    const plan = planScenePlayback({
      tracks: [track],
      master: new AudioScene({ createContext: () => fakeContext() }).master,
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4 },
      resolveOffsetSec: () => 0,
      playheadSec: 0.6,
      sampleRate: 48000,
    });
    expect(plan.midiCcJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cc: 74, value: 40, atSec: 0 }),
        expect.objectContaining({ cc: 74, value: 90, atSec: expect.closeTo(0.9) }),
      ]),
    );
    expect(plan.midiCcJobs.some((job) => job.value === 10)).toBe(false);
  });
});

describe('AudioScene.transport.play schedules clips', () => {
  it('builds one plan and one origin after the graph exists', async () => {
    const ctx = fakeContext(3);
    const scene = new AudioScene({ createContext: () => ctx });
    const track = scene.addTrack(new Track());
    track.addClip(new Clip({ buffer: fakeBuffer() }), { at: Time.seconds(1) });
    await scene.start();
    scene.transport.play();
    expect(scene.transport.state).toBe('playing');
    expect(scene.playback.lastPlan?.jobs).toHaveLength(1);
    expect(scene.playback.lastStart?.originCtx).toBeCloseTo(3 + PDC_SCHEDULE_AHEAD_SEC);
    expect(scene.playback.lastPlan?.jobs[0]!.whenSec).toBeCloseTo(1);
  });

  it('pause freezes the playhead and stop returns to zero', async () => {
    let now = 5;
    const scene = new AudioScene({
      createContext: () => ({
        get currentTime() {
          return now;
        },
        sampleRate: 48000,
        state: 'running' as const,
        async resume() {},
        async close() {},
      }),
    });
    await scene.start();
    scene.transport.play();
    const audible = scene.playback.lastStart!.audibleOriginCtx;
    now = audible + 2;
    expect(scene.transport.position).toBeCloseTo(2);
    scene.transport.pause();
    now = audible + 9;
    expect(scene.transport.position).toBeCloseTo(2);
    scene.transport.stop();
    expect(scene.transport.position).toBe(0);
    expect(scene.transport.state).toBe('stopped');
  });

  it('records MIDI jobs on the same origin as audio', async () => {
    const scene = new AudioScene({ createContext: () => fakeContext(1) });
    const track = scene.addTrack(new Track());
    track.addMidiClip(
      new MidiClip({ notes: [{ pitch: 60, velocity: 1, startBeat: 0, durationBeats: 1 }] }),
      { at: Time.seconds(0) },
    );
    await scene.start();
    scene.transport.play();
    expect(scene.playback.lastPlan?.midiJobs).toHaveLength(1);
    expect(scene.midiPlayback.lastJobs).toHaveLength(1);
    expect(scene.midiPlayback.lastStart?.originCtx).toBe(scene.playback.lastStart?.originCtx);
  });

  it('schedules warped B from the pulled crossfade head, not the old trim', () => {
    const track = new Track();
    track.addClip(
      new Clip({
        buffer: fakeBuffer(384000),
        region: { trimStartSec: 0, trimEndSec: 4 },
        crossfadeToNextSec: 0.5,
      }),
      { at: Time.seconds(0) },
    );
    track.addClip(
      new Clip({
        buffer: fakeBuffer(384000),
        region: { trimStartSec: 2, trimEndSec: 6 },
        warpSegments: [
          { fileStartSec: 2, fileEndSec: 4, ratio: 0.5, localOffsetSec: 0 },
          { fileStartSec: 4, fileEndSec: 6, ratio: 1.5, localOffsetSec: 1 },
        ],
      }),
      { at: Time.seconds(4) },
    );
    const plan = planScenePlayback({
      tracks: [track],
      master: new AudioScene({ createContext: () => fakeContext() }).master,
      timeContext: { bpm: 120, ppqn: 24, beatsPerBar: 4 },
      resolveOffsetSec: (t, i) => t.clips[i]!.at.toSeconds({ bpm: 120, ppqn: 24, beatsPerBar: 4 }),
      playheadSec: 0,
      sampleRate: 48000,
    });
    const bJobs = plan.jobs.filter((job) => job.clipId === track.clips[1]!.clip.id);
    expect(bJobs[0]!.whenSec).toBeCloseTo(3.5);
    expect(bJobs[0]!.fileOffsetSec).toBeCloseTo(1.5);
    expect(bJobs[0]!.fileDurationSec).toBeCloseTo(0.5);
    const last = bJobs[bJobs.length - 1]!;
    expect(last.whenSec + last.fileDurationSec / last.playbackRate).toBeCloseTo(8);
  });

  it('seek while stopped sets the start point of the next play', async () => {
    const scene = new AudioScene({ createContext: () => fakeContext() });
    const track = scene.addTrack(new Track());
    track.addClip(new Clip({ buffer: fakeBuffer(96000) }), { at: Time.seconds(0) });
    await scene.start();
    scene.transport.seek(0.5);
    scene.transport.play();
    expect(scene.playback.lastPlan?.jobs[0]!.fileOffsetSec).toBeCloseTo(0.5);
  });
});
