import { describe, expect, it } from 'vitest';
import { MidiPlayback, type MidiVoiceTarget } from '../../src/playback/MidiPlayback';
import type { PlannedMidiCcJob, PlannedMidiJob } from '../../src/playback/plan';
import type { AudioContextLike } from '../../src/AudioContextLike';

function fakeCtx(currentTime = 0): AudioContextLike {
  return {
    currentTime,
    sampleRate: 48000,
    state: 'running',
    resume: async () => {},
    close: async () => {},
    createBufferSource: () => ({}),
  } as unknown as AudioContextLike;
}

function job(partial: Partial<PlannedMidiJob> & Pick<PlannedMidiJob, 'trackId' | 'pitch'>): PlannedMidiJob {
  return {
    clipId: 1,
    velocity: 0.8,
    onSec: 0.2,
    offSec: 0.5,
    pdcSec: 0,
    ...partial,
  };
}

describe('MidiPlayback', () => {
  it('records jobs on a fake context without arming timers', () => {
    const playback = new MidiPlayback();
    const jobs = [job({ trackId: 1, pitch: 60 })];
    const start = playback.start(fakeCtx(0), 1, jobs, new Map());
    expect(start.jobs).toBe(jobs);
    expect(playback.lastJobs).toBe(jobs);
  });

  it('posts scheduled notes and CC with AudioContext time, no timers', () => {
    const hits: Array<[string, number, number?]> = [];
    const target: MidiVoiceTarget = {
      scheduled: true,
      noteOn: (note, options) => hits.push(['on', note, options?.when]),
      noteOff: (note, options) => hits.push(['off', note, options?.when]),
      controlChange: (cc, value, options) => hits.push(['cc', cc, options?.when]),
    };
    const ccJobs: PlannedMidiCcJob[] = [
      { trackId: 7, clipId: 1, cc: 74, value: 90, atSec: 0.1, pdcSec: 0 },
    ];
    new MidiPlayback().start(
      fakeCtx(0),
      2,
      [job({ trackId: 7, pitch: 64, onSec: 0.2, offSec: 0.5 })],
      new Map([[7, target]]),
      ccJobs,
    );
    expect(hits).toEqual([
      ['on', 64, 2.2],
      ['off', 64, 2.5],
      ['cc', 74, 2.1],
    ]);
  });
});
