/**
 * A session as data.
 *
 * The argument, in one line: **an ASL graph became portable when it stopped
 * being code and became data any interpreter could replay, and nothing about a
 * session is less serializable than a graph.**
 *
 * Crate's session layer is roughly 5,600 lines of TypeScript, and a native
 * host that wants crate as the engine under a DAW currently copies 1,299 more
 * from `webshims/crateScenePlayback.ts` rather than importing anything. That
 * function interleaves three jobs: computing what should play, reading the
 * files it needs, and building an audio graph. Only the first is portable, and
 * it is the only one that has to agree across implementations.
 *
 * A `ScenePlan` is that first job's output. Track topology, clip placements
 * with their warp segments, automation lanes, the tempo map and the transport
 * origin, all in beats and seconds, with no buffer, no context and no file
 * handle anywhere in it. `schedulePlan` turns one into a sample-accurate
 * schedule: for each clip, which part of which source to play, how long from
 * now, at what rate and at what gain, plus every automated parameter's value
 * at that instant.
 *
 * What that buys: a host executes a plan the way it already executes a
 * compiled graph, and the same plan can be checked to produce the same
 * schedule in two languages. What it deliberately does not do is read a file
 * or open a device. `source` is an opaque id the host resolves, exactly as
 * `deviceId` is for MIDI (`host/hostLocal.ts`); a plan is portable between
 * machines and a file path is not.
 *
 * Not in v1: MIDI clips, insert chains beyond their reported latency, and
 * sends. Insert *latency* is here because it moves when a clip starts, which
 * is a scheduling fact; which plugins are in the chain is not.
 */
import { TempoMap, type TempoCurve } from '../TempoMap';
import {
  clipPlaybackWindows,
  clipTimelineDurationSec,
  type ClipPlaybackWindow,
  type WarpSegment,
} from '../clip/region';
import { clipGainLinear } from '../clip/fades';
import { AutomationLane } from '../automation/AutomationLane';
import { Easing, type EasingName } from '../automation/Easing';
import { Time, type TimeContext } from '../Time';

/**
 * Bumped when the shape changes, not when the scheduling does.
 *
 * A host that does not understand the version must refuse the plan rather than
 * execute the half it recognises. Playing a project with the automation
 * silently dropped is worse than refusing to play it.
 */
export const SCENE_PLAN_VERSION = 1;

export interface ScenePlanTransport {
  /** Where the playhead sits when the plan is executed, in timeline seconds. */
  originSec: number;
  bpm: number;
  beatsPerBar?: number;
  beatUnit?: number;
  /** Null means one constant tempo at `bpm`. */
  tempoChanges: Array<{ atBeat: number; bpm: number; curve: TempoCurve }> | null;
  /** Ticks per quarter note, for positions expressed in bars. */
  ppqn: number;
}

export interface ScenePlanClip {
  id: string;
  /**
   * An id the host resolves to audio. Never a path: a plan that named
   * `/var/mobile/.../take3.wav` would be portable to exactly one container on
   * exactly one device, which is the same mistake `deviceId` avoids for MIDI.
   */
  source: string;
  /** Timeline position of the clip's start, in seconds. */
  offsetSec: number;
  trimStartSec: number;
  /** Null means to the end of the source. */
  trimEndSec: number | null;
  stretchRatio: number;
  /** When present these replace `stretchRatio` entirely, never both. */
  warpSegments: WarpSegment[] | null;
  gainDb: number;
  muted: boolean;
}

export interface ScenePlanLane {
  /** The parameter this lane writes, addressed by name. */
  target: string;
  startBeats: number;
  endBeats: number;
  from: number;
  to: number;
  shape: EasingName;
  points: Array<{ t: number; value: number }> | null;
  chase: boolean;
  hold: boolean;
  invert: boolean;
}

export interface ScenePlanTrack {
  index: number;
  volume: number;
  pan: number;
  muted: boolean;
  /**
   * Reported latency of this track's insert chain.
   *
   * Here because it moves when a clip has to start, which is a scheduling
   * fact. Which plugins produce it is not a scheduling fact and is not here.
   */
  latencySamples: number;
  clips: ScenePlanClip[];
  automation: ScenePlanLane[];
}

export interface ScenePlan {
  version: number;
  transport: ScenePlanTransport;
  master: { volume: number; latencySamples: number };
  tracks: ScenePlanTrack[];
}

/**
 * Named for the plan rather than as a bare `ScheduledClip`, because
 * `graph/Track.ts` already exports one of those and it is a different thing:
 * that is a clip attached to a live scene, this is a clip resolved out of a
 * document.
 */
export interface PlanClipSchedule {
  clipId: string;
  source: string;
  windows: ClipPlaybackWindow[];
  /** Clip gain as a linear multiplier, before the track fader. */
  gain: number;
  /**
   * The span of the source a host has to make available, in file seconds.
   *
   * Derived from the windows rather than from the trim, because a playhead
   * partway into a clip needs less of the file than the clip names, and
   * decoding the whole take to play its last two seconds is the difference
   * between starting instantly and not.
   *
   * Null when nothing plays.
   */
  decodeStartSec: number | null;
  decodeEndSec: number | null;
}

export interface PlanTrackSchedule {
  index: number;
  /** Track fader as a linear multiplier. Zero when muted. */
  gain: number;
  pan: number;
  latencySamples: number;
  clips: PlanClipSchedule[];
  /** Every automated parameter that writes at this instant, by target. */
  automation: Record<string, number>;
}

export interface PlanSchedule {
  atSec: number;
  atBeats: number;
  bpm: number;
  masterGain: number;
  tracks: PlanTrackSchedule[];
}

export function planTempoMap(transport: ScenePlanTransport): TempoMap | undefined {
  const changes = transport.tempoChanges;
  if (!changes) return undefined;
  const base = changes.find((change) => change.atBeat === 0);
  return new TempoMap(
    changes.filter((change) => change.atBeat > 0),
    base?.bpm ?? transport.bpm,
    base?.curve ?? 'jump',
  );
}

export function planTimeContext(transport: ScenePlanTransport): TimeContext {
  return {
    bpm: transport.bpm,
    ppqn: transport.ppqn,
    beatsPerBar: transport.beatsPerBar,
    beatUnit: transport.beatUnit,
    tempoMap: planTempoMap(transport),
  };
}

/** Timeline seconds this clip occupies, which a host needs to lay out a view. */
export function planClipDurationSec(clip: ScenePlanClip, sourceDurationSec: number): number {
  const trimEnd =
    clip.trimEndSec != null && clip.trimEndSec > clip.trimStartSec
      ? Math.min(clip.trimEndSec, sourceDurationSec)
      : sourceDurationSec;
  return clipTimelineDurationSec({
    trimStartSec: clip.trimStartSec,
    trimEndSec: trimEnd,
    stretchRatio: clip.stretchRatio,
    warpSegments: clip.warpSegments,
  });
}

/**
 * One clip's schedule at a playhead.
 *
 * `sourceDurationSec` is the host's answer for how long the source is, because
 * a plan cannot know and must not guess. A clip whose `trimEndSec` is null
 * runs to whatever the host says the source is.
 */
export function scheduleClip(
  clip: ScenePlanClip,
  playheadSec: number,
  sourceDurationSec: number,
): PlanClipSchedule {
  const trimEnd =
    clip.trimEndSec != null && clip.trimEndSec > clip.trimStartSec
      ? Math.min(clip.trimEndSec, sourceDurationSec)
      : sourceDurationSec;

  const windows = clip.muted
    ? []
    : clipPlaybackWindows({
        offsetSec: clip.offsetSec,
        trimStartSec: clip.trimStartSec,
        trimEndSec: trimEnd,
        stretchRatio: clip.stretchRatio,
        warpSegments: clip.warpSegments,
        playheadSec,
      });

  let decodeStartSec: number | null = null;
  let decodeEndSec: number | null = null;
  for (const window of windows) {
    const end = window.fileOffsetSec + window.fileDurationSec;
    decodeStartSec = decodeStartSec == null ? window.fileOffsetSec : Math.min(decodeStartSec, window.fileOffsetSec);
    decodeEndSec = decodeEndSec == null ? end : Math.max(decodeEndSec, end);
  }

  return {
    clipId: clip.id,
    source: clip.source,
    windows,
    gain: clipGainLinear(clip.gainDb),
    decodeStartSec,
    decodeEndSec,
  };
}

function laneFor(lane: ScenePlanLane): AutomationLane {
  return new AutomationLane({
    shape: Easing[lane.shape],
    from: lane.from,
    to: lane.to,
    range: { start: Time.beats(lane.startBeats), end: Time.beats(lane.endBeats) },
    points: lane.points ?? undefined,
    chase: lane.chase,
    hold: lane.hold,
    invert: lane.invert,
  });
}

/**
 * A whole plan, at one instant.
 *
 * This is the function a host calls instead of copying `buildScene`. It
 * composes the three ported slices: the tempo map answers where the playhead
 * is musically, clip placement answers what plays, and the automation lanes
 * answer what every parameter is worth. Nothing here reads a file, opens a
 * device, or allocates a buffer.
 *
 * `sourceDurationSec` resolves a source id to its length. A source the host
 * does not know is treated as zero-length rather than as an error, so one
 * missing take costs one silent clip and not the whole session.
 */
export function schedulePlan(
  plan: ScenePlan,
  atSec: number,
  sourceDurationSec: (source: string) => number | undefined,
): PlanSchedule {
  const ctx = planTimeContext(plan.transport);
  const playheadSec = plan.transport.originSec + atSec;
  const atBeats = Time.seconds(playheadSec).toBeats(ctx);

  const tracks: PlanTrackSchedule[] = plan.tracks.map((track) => {
    const automation: Record<string, number> = {};
    for (const lane of track.automation) {
      const value = laneFor(lane).evaluate(playheadSec, ctx);
      if (value !== undefined) automation[lane.target] = value;
    }
    return {
      index: track.index,
      // A muted track is exactly zero, not a very small number: it must not
      // leak and it must not cost a fade.
      gain: track.muted ? 0 : track.volume,
      pan: track.pan,
      latencySamples: track.latencySamples,
      clips: track.clips.map((clip) =>
        scheduleClip(clip, playheadSec, sourceDurationSec(clip.source) ?? 0),
      ),
      automation,
    };
  });

  return {
    atSec,
    atBeats,
    bpm: ctx.tempoMap ? ctx.tempoMap.bpmAtBeat(atBeats) : plan.transport.bpm,
    masterGain: plan.master.volume,
    tracks,
  };
}
