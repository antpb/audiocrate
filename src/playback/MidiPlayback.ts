import type { AudioContextLike } from '../AudioContextLike';
import type { PlannedMidiCcJob, PlannedMidiJob } from './plan';

export interface MidiVoiceTarget {
  noteOn(note: number, options?: { velocity?: number; when?: number }): void;
  noteOff(note: number, options?: { when?: number }): void;
  allNotesOff?(): void;
  controlChange?(cc: number, value: number, options?: { when?: number }): void;
  /**
   * Live worklet voices honor `when` as AudioContext time. Bound Materials
   * (VoicePool) do not: their slot table has to move on the same call as
   * the sounding note, so those still use timers from this class.
   */
  scheduled?: boolean;
}

export interface MidiPlaybackStart {
  originCtx: number;
  jobs: PlannedMidiJob[];
  ccJobs: PlannedMidiCcJob[];
}

function isWebClock(ctx: AudioContextLike): boolean {
  const raw = ctx as AudioContextLike & { createBufferSource?: unknown };
  return typeof raw.createBufferSource === 'function';
}

/**
 * Schedules planned MIDI notes and CC onto bound materials. Fake test
 * contexts record the jobs and do not arm timers. Live instrument voices
 * (`scheduled: true`) receive every event immediately with an AudioContext
 * time; the worklet fires them on the audio thread.
 */
export class MidiPlayback {
  lastJobs: PlannedMidiJob[] | null = null;
  lastCcJobs: PlannedMidiCcJob[] | null = null;
  lastStart: MidiPlaybackStart | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private targets = new Map<number, MidiVoiceTarget>();

  start(
    ctx: AudioContextLike,
    originCtx: number,
    jobs: PlannedMidiJob[],
    targets: Map<number, MidiVoiceTarget>,
    ccJobs: PlannedMidiCcJob[] = [],
  ): MidiPlaybackStart {
    this.stop();
    this.lastJobs = jobs;
    this.lastCcJobs = ccJobs;
    this.targets = targets;
    const start: MidiPlaybackStart = { originCtx, jobs, ccJobs };
    this.lastStart = start;
    if (!isWebClock(ctx) || targets.size === 0) return start;

    for (const job of jobs) {
      const voice = targets.get(job.trackId);
      if (!voice) continue;
      const onWhen = originCtx + job.onSec + job.pdcSec;
      const offWhen = originCtx + job.offSec + job.pdcSec;
      if (offWhen <= ctx.currentTime) continue;
      if (voice.scheduled) {
        voice.noteOn(job.pitch, { velocity: job.velocity, when: onWhen });
        voice.noteOff(job.pitch, { when: offWhen });
        continue;
      }
      const onDelay = (onWhen - ctx.currentTime) * 1000;
      const offDelay = (offWhen - ctx.currentTime) * 1000;
      if (onDelay <= 0) voice.noteOn(job.pitch, { velocity: job.velocity });
      else this.timers.push(setTimeout(() => voice.noteOn(job.pitch, { velocity: job.velocity }), onDelay));
      this.timers.push(setTimeout(() => voice.noteOff(job.pitch), offDelay));
    }

    for (const job of ccJobs) {
      const voice = targets.get(job.trackId);
      if (!voice?.controlChange) continue;
      const atWhen = originCtx + job.atSec + job.pdcSec;
      if (voice.scheduled) {
        voice.controlChange(job.cc, job.value, { when: atWhen });
        continue;
      }
      const delay = (atWhen - ctx.currentTime) * 1000;
      if (delay <= 0) voice.controlChange(job.cc, job.value);
      else this.timers.push(setTimeout(() => voice.controlChange?.(job.cc, job.value), delay));
    }
    return start;
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const voice of this.targets.values()) {
      try {
        voice.allNotesOff?.();
      } catch {
        /* already gone */
      }
    }
    this.targets = new Map();
  }
}
