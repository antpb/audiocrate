/**
 * Building a scene plan from a project.
 *
 * `ScenePlan.ts` defines the document and `schedulePlan` executes it. This is
 * the other end: turning what a DAW actually has (clips in milliseconds, track
 * faders, a tempo, a playhead) into one.
 *
 * It exists to answer a specific doubt. A plan format designed against its own
 * test cases will describe those cases and nothing else. The way to find out
 * whether it describes a *session* is to build one from the same inputs
 * `webshims/crateScenePlayback.ts` already takes, and see what will not fit.
 *
 * ## What this deliberately does not do
 *
 * **It does not resolve sources.** `sourceId` is a required callback, not a
 * default that hashes a path, because a plan that named
 * `file:///var/mobile/.../take3.wav` would be portable to exactly one
 * container on one device. Making the caller name the id is what keeps that
 * rule enforceable rather than aspirational: there is nowhere for a path to
 * leak in by accident.
 *
 * **It does not decide what is audible.** `buildScene` skips clips outside a
 * 180-second window around the playhead, which is a decision about how much to
 * decode at once. A plan is the whole session and `schedulePlan` answers what
 * plays at an instant, so pre-filtering here would bake one host's memory
 * budget into the document.
 *
 * **It does not hydrate anything.** No file is read, no AudioMaterial is loaded, no
 * context is created.
 */
import { warpSegmentsFromMs } from '../clip/region';
import {
  SCENE_PLAN_VERSION,
  type ScenePlan,
  type ScenePlanClip,
  type ScenePlanLane,
  type ScenePlanTrack,
} from './ScenePlan';
import type { TempoCurve } from '../TempoMap';

export interface PlanBuildClip {
  /** Host-side identity. Never copied into the plan; see `sourceId`. */
  audioFileUri: string;
  trackIndex: number;
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number | null;
  clipGainDb?: number;
  isMuted?: boolean;
  stretchRatio?: number;
  warpSegments?: Array<{
    fileStartMs: number;
    fileEndMs: number;
    ratio: number;
    localOffsetMs: number;
  }> | null;
  /** Stable id for this clip. Generated from the track and its position when absent. */
  id?: string;
}

export interface PlanBuildTrack {
  index: number;
  volume?: number;
  pan?: number;
  muted?: boolean;
  /** Reported latency of this track's insert chain, in samples. */
  latencySamples?: number;
  automation?: ScenePlanLane[];
}

export interface PlanBuildInput {
  clips: readonly PlanBuildClip[];
  /**
   * Every track the session has, including ones with no clips.
   *
   * An armed track with nothing recorded on it still has a fader, still has
   * automation, and still has to appear. `buildScene` learned this the same
   * way: taking the tracks from the clips leaves an empty armed track with no
   * mixer strip.
   */
  tracks: readonly PlanBuildTrack[];
  /** Where the playhead sits, in milliseconds. */
  startPositionMs?: number;
  bpm: number;
  ppqn?: number;
  beatsPerBar?: number;
  beatUnit?: number;
  tempoChanges?: ReadonlyArray<{ atBeat: number; bpm: number; curve?: TempoCurve }> | null;
  master?: { volume?: number; latencySamples?: number };
  /**
   * Maps a clip to the id a host will resolve back to audio.
   *
   * Required on purpose. See the note at the top of this file.
   */
  sourceId: (clip: PlanBuildClip) => string;
}

function ms(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value / 1000;
}

function clipFor(clip: PlanBuildClip, index: number, sourceId: (clip: PlanBuildClip) => string): ScenePlanClip {
  const trimStartSec = Math.max(0, ms(clip.trimStartMs) ?? 0);
  const trimEndSec = ms(clip.trimEndMs);
  const source = sourceId(clip);
  if (!source) {
    throw new TypeError(
      `buildScenePlan: sourceId returned nothing for a clip on track ${clip.trackIndex}. ` +
        `A plan cannot name a source it has no id for.`,
    );
  }
  return {
    id: clip.id ?? `t${clip.trackIndex}-c${index}`,
    source,
    offsetSec: ms(clip.offsetMs) ?? 0,
    trimStartSec,
    // A trim end at or before the start is not a zero-length clip, it is an
    // unset field: the same reading `resolveTrimEndSec` takes.
    trimEndSec: trimEndSec != null && trimEndSec > trimStartSec ? trimEndSec : null,
    stretchRatio: clip.stretchRatio != null && clip.stretchRatio > 0 ? clip.stretchRatio : 1,
    warpSegments: warpSegmentsFromMs(clip.warpSegments),
    gainDb: clip.clipGainDb ?? 0,
    muted: clip.isMuted === true,
  };
}

/**
 * A plan from a project.
 *
 * Tracks come out sorted by index and each track's clips keep the order they
 * arrived in, because the render's summation order is part of the contract
 * (`planRender.ts`) and a plan built twice from the same project has to
 * schedule identically.
 */
export function buildScenePlan(input: PlanBuildInput): ScenePlan {
  const byTrack = new Map<number, PlanBuildClip[]>();
  for (const clip of input.clips) {
    const list = byTrack.get(clip.trackIndex) ?? [];
    list.push(clip);
    byTrack.set(clip.trackIndex, list);
  }

  // Every declared track, plus any a clip refers to that was not declared: a
  // clip on a track nobody listed is a project inconsistency, and dropping it
  // silently is how a take goes missing.
  const indices = new Set<number>([...input.tracks.map((track) => track.index), ...byTrack.keys()]);
  const declared = new Map(input.tracks.map((track) => [track.index, track]));

  const tracks: ScenePlanTrack[] = [...indices]
    .sort((a, b) => a - b)
    .map((index) => {
      const track = declared.get(index);
      return {
        index,
        volume: track?.volume ?? 1,
        pan: track?.pan ?? 0,
        muted: track?.muted === true,
        latencySamples: track?.latencySamples ?? 0,
        clips: (byTrack.get(index) ?? []).map((clip, i) => clipFor(clip, i, input.sourceId)),
        automation: track?.automation ? track.automation.map((lane) => ({ ...lane })) : [],
      };
    });

  return {
    version: SCENE_PLAN_VERSION,
    transport: {
      originSec: (input.startPositionMs ?? 0) / 1000,
      bpm: input.bpm,
      ppqn: input.ppqn ?? 960,
      beatsPerBar: input.beatsPerBar,
      beatUnit: input.beatUnit,
      tempoChanges: input.tempoChanges
        ? input.tempoChanges.map((change) => ({
            atBeat: change.atBeat,
            bpm: change.bpm,
            curve: change.curve ?? 'jump',
          }))
        : null,
    },
    master: {
      volume: input.master?.volume ?? 1,
      latencySamples: input.master?.latencySamples ?? 0,
    },
    tracks,
  };
}
