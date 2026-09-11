import { AudioNode3, type AudioNode3Options } from './AudioNode3';
import type { Clip } from './Clip';
import type { AudioMaterial } from './AudioMaterial';
import type { MidiClip } from './MidiClip';
import type { Time } from '../Time';

export interface ScheduledClip {
  readonly clip: Clip;
  /** Structured, unresolved until render/playback time against the owning scene's transport. */
  readonly at: Time;
}

export interface ScheduledMidiClip {
  readonly clip: MidiClip;
  readonly at: Time;
}

export type TrackOptions = AudioNode3Options;

export class Track extends AudioNode3 {
  /**
   * A note-driven source AudioMaterial, distinct from `materials` (the ordered
   * insert chain, which processes `input`). An instrument ignores `input`
   * and generates its own signal from MIDI. Chaining one into `materials`
   * would be structurally wrong: nothing upstream feeds it audio. One
   * instrument per track.
   */
  instrument: AudioMaterial | null = null;

  /**
   * This track's index in the hosted project it was loaded from, set by
   * `ProjectLoader`. Clip-level automation lanes (the virtual slot -1)
   * address tracks by this number, not by crate's own `id`.
   */
  hostedTrackIndex?: number;

  private readonly scheduledClips: ScheduledClip[] = [];
  private readonly scheduledMidi: ScheduledMidiClip[] = [];

  addClip(clip: Clip, options: { at: Time }): ScheduledClip {
    const scheduled: ScheduledClip = { clip, at: options.at };
    this.scheduledClips.push(scheduled);
    return scheduled;
  }

  removeClip(clip: Clip): boolean {
    const index = this.scheduledClips.findIndex((s) => s.clip === clip);
    if (index === -1) return false;
    this.scheduledClips.splice(index, 1);
    return true;
  }

  get clips(): readonly ScheduledClip[] {
    return this.scheduledClips;
  }

  addMidiClip(clip: MidiClip, options: { at: Time }): ScheduledMidiClip {
    const scheduled: ScheduledMidiClip = { clip, at: options.at };
    this.scheduledMidi.push(scheduled);
    return scheduled;
  }

  removeMidiClip(clip: MidiClip): boolean {
    const index = this.scheduledMidi.findIndex((s) => s.clip === clip);
    if (index === -1) return false;
    this.scheduledMidi.splice(index, 1);
    return true;
  }

  get midiClips(): readonly ScheduledMidiClip[] {
    return this.scheduledMidi;
  }
}
