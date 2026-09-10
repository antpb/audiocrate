import { evaluateNodeAutomation } from '../automation/evaluate';
import { projectClipCrossfades, type CrossfadeClipDraft } from '../clip/crossfade';
import type { FadeCurve } from '../clip/fades';
import { clipPlaybackWindows, resolveTrimEndSec } from '../clip/region';
import type { Bus } from '../graph/Bus';
import { expandMidiNotes, midiCcValue, midiVelocity } from '../graph/MidiClip';
import type { Track } from '../graph/Track';
import { pdcStartDelaySec } from '../host/pdc';
import type { TimeContext } from '../Time';

export interface PlannedClipJob {
  trackId: number;
  clipId: number;
  whenSec: number;
  fileOffsetSec: number;
  fileDurationSec: number;
  playbackRate: number;
  volume: number;
  pan: number;
  pdcSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
  gainDb: number;
  trimStartSec: number;
  trimEndSec: number;
}

export interface PlannedMidiJob {
  trackId: number;
  clipId: number;
  pitch: number;
  velocity: number;
  onSec: number;
  offSec: number;
  pdcSec: number;
}

export interface PlannedMidiCcJob {
  trackId: number;
  clipId: number;
  cc: number;
  value: number;
  atSec: number;
  pdcSec: number;
}

export interface PlaybackPlan {
  jobs: PlannedClipJob[];
  midiJobs: PlannedMidiJob[];
  midiCcJobs: PlannedMidiCcJob[];
  playheadSec: number;
  maxTrackLatencySamples: number;
  masterLatencySamples: number;
  sampleRate: number;
}

export interface PlanScenePlaybackInput {
  tracks: readonly Track[];
  master: Bus;
  timeContext: TimeContext;
  resolveOffsetSec: (track: Track, clipIndex: number) => number;
  resolveMidiOffsetSec?: (track: Track, clipIndex: number) => number;
  playheadSec: number;
  sampleRate: number;
}

function emptyPlan(input: PlanScenePlaybackInput, playheadSec: number): PlaybackPlan {
  return {
    jobs: [],
    midiJobs: [],
    midiCcJobs: [],
    playheadSec,
    maxTrackLatencySamples: 0,
    masterLatencySamples: input.master.latencySamples,
    sampleRate: input.sampleRate,
  };
}

function draftFromClip(track: Track, clipIndex: number, offsetSec: number): CrossfadeClipDraft | null {
  const scheduled = track.clips[clipIndex];
  if (!scheduled) return null;
  const clip = scheduled.clip;
  const bufferDur = clip.buffer.length / clip.buffer.sampleRate;
  return {
    id: clip.id,
    offsetSec,
    trimStartSec: Math.max(0, clip.region.trimStartSec),
    trimEndSec: resolveTrimEndSec(clip.region, bufferDur),
    stretchRatio: clip.stretchRatio,
    warpSegments: clip.warpSegments,
    fadeInSec: clip.fadeInSec,
    fadeOutSec: clip.fadeOutSec,
    fadeInCurve: clip.fadeInCurve,
    fadeOutCurve: clip.fadeOutCurve,
    gainDb: clip.gainDb,
    crossfadeToNextSec: clip.crossfadeToNextSec,
    crossfadeCurve: clip.crossfadeCurve,
  };
}

/**
 * Build every clip window and MIDI note before any audio starts: one plan,
 * then one origin, then start all.
 */
export function planScenePlayback(input: PlanScenePlaybackInput): PlaybackPlan {
  const playheadSec = Math.max(0, input.playheadSec);
  if (input.master.muted) return emptyPlan(input, playheadSec);

  const liveTracks = input.tracks.filter((track) => !track.muted);
  let maxTrackLatency = 0;
  for (const track of liveTracks) {
    if (track.latencySamples > maxTrackLatency) maxTrackLatency = track.latencySamples;
  }

  const jobs: PlannedClipJob[] = [];
  const midiJobs: PlannedMidiJob[] = [];
  const midiCcJobs: PlannedMidiCcJob[] = [];
  const secPerBeat = 60 / (input.timeContext.bpm > 0 ? input.timeContext.bpm : 120);
  const tempoMap = input.timeContext.tempoMap;
  /**
   * Where a beat inside a MIDI clip lands on the timeline.
   *
   * A note's `startBeat` is measured from the clip's own start, so under a
   * tempo map it has to be resolved against the clip's absolute musical
   * position rather than multiplied by one tempo. Without a map this is the
   * identical expression it always was, which is what keeps a scene that
   * never sets one scheduling exactly as before.
   */
  const beatOffsetSec = (clipOffsetSec: number, beat: number): number => {
    if (!tempoMap) return clipOffsetSec + beat * secPerBeat;
    return tempoMap.secondsAtBeat(tempoMap.beatAtSeconds(clipOffsetSec) + beat);
  };

  for (const track of liveTracks) {
    const auto = evaluateNodeAutomation(track, playheadSec, input.timeContext);
    // Track fader only. The master fader is a node in `ScenePlayback`
    // rather than a multiplication folded in here, so a live mixer can move
    // master without re-planning every track.
    const volume = auto.gain ?? auto.volume ?? track.volume;
    const pan = auto.pan ?? track.pan;
    const pdcSec = pdcStartDelaySec(track.latencySamples, maxTrackLatency, input.sampleRate);

    const drafts = track.clips
      .map((_, clipIndex) => draftFromClip(track, clipIndex, input.resolveOffsetSec(track, clipIndex)))
      .filter((draft): draft is CrossfadeClipDraft => draft != null);
    const projected = projectClipCrossfades(drafts);
    const byId = new Map(projected.map((draft) => [draft.id, draft]));

    track.clips.forEach((scheduled) => {
      const clip = scheduled.clip;
      const draft = byId.get(clip.id);
      if (!draft) return;
      const windows = clipPlaybackWindows({
        offsetSec: draft.offsetSec,
        trimStartSec: draft.trimStartSec,
        trimEndSec: draft.trimEndSec,
        stretchRatio: draft.stretchRatio,
        warpSegments: draft.warpSegments,
        playheadSec,
      });
      for (const win of windows) {
        jobs.push({
          trackId: track.id,
          clipId: clip.id,
          whenSec: win.whenSec,
          fileOffsetSec: win.fileOffsetSec,
          fileDurationSec: win.fileDurationSec,
          playbackRate: win.playbackRate,
          volume,
          pan,
          pdcSec,
          fadeInSec: draft.fadeInSec,
          fadeOutSec: draft.fadeOutSec,
          fadeInCurve: draft.fadeInCurve,
          fadeOutCurve: draft.fadeOutCurve,
          gainDb: draft.gainDb,
          trimStartSec: draft.trimStartSec,
          trimEndSec: draft.trimEndSec,
        });
      }
    });

    track.midiClips.forEach((scheduled, clipIndex) => {
      const offsetSec = input.resolveMidiOffsetSec
        ? input.resolveMidiOffsetSec(track, clipIndex)
        : scheduled.at.toSeconds(input.timeContext);
      for (const note of expandMidiNotes(scheduled.clip.notes)) {
        const onSec = beatOffsetSec(offsetSec, note.startBeat) - playheadSec;
        // The note's end is a musical length from its start, so a tempo
        // change inside a held note shortens or lengthens it in seconds. That
        // is what holding a note across a tempo change means.
        const offSec =
          beatOffsetSec(offsetSec, note.startBeat + Math.max(0, note.durationBeats)) - playheadSec;
        if (offSec <= 0) continue;
        midiJobs.push({
          trackId: track.id,
          clipId: scheduled.clip.id,
          pitch: note.pitch | 0,
          velocity: midiVelocity(note.velocity),
          onSec,
          offSec,
          pdcSec,
        });
        for (const event of note.ccEvents ?? []) {
          midiCcJobs.push({
            trackId: track.id,
            clipId: scheduled.clip.id,
            cc: event.cc | 0,
            value: midiCcValue(event.value),
            atSec: onSec,
            pdcSec,
          });
        }
      }
      for (const lane of scheduled.clip.ccLanes) {
        let carried: number | undefined;
        for (const point of lane.points) {
          const atSec = beatOffsetSec(offsetSec, point.startBeat) - playheadSec;
          if (atSec < 0) {
            carried = midiCcValue(point.value);
            continue;
          }
          midiCcJobs.push({
            trackId: track.id,
            clipId: scheduled.clip.id,
            cc: lane.cc | 0,
            value: midiCcValue(point.value),
            atSec,
            pdcSec,
          });
        }
        if (carried !== undefined) {
          midiCcJobs.push({
            trackId: track.id,
            clipId: scheduled.clip.id,
            cc: lane.cc | 0,
            value: carried,
            atSec: 0,
            pdcSec,
          });
        }
      }
    });
  }

  return {
    jobs,
    midiJobs,
    midiCcJobs,
    playheadSec,
    maxTrackLatencySamples: maxTrackLatency,
    masterLatencySamples: input.master.latencySamples,
    sampleRate: input.sampleRate,
  };
}
