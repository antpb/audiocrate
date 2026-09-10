/**
 * Does the plan format describe a real session, or only its own test cases?
 *
 * `planConformance` proves two implementations schedule a plan the same way.
 * It cannot prove the plan format is *sufficient*, because its plans were
 * written to exercise the scheduler. This builds one from the shape a DAW
 * actually has (`PlaybackClip` in milliseconds, faders, a playhead) and checks
 * what survives the trip.
 */
import { describe, expect, it } from 'vitest';
import { buildScenePlan, type PlanBuildInput } from '../../src/session/buildScenePlan';
import { schedulePlan } from '../../src/session/ScenePlan';
import { renderPlan } from '../../src/session/planRender';

const sourceId = (clip: { audioFileUri: string }) => clip.audioFileUri.split('/').pop()!;

function input(over: Partial<PlanBuildInput> = {}): PlanBuildInput {
  return {
    clips: [],
    tracks: [],
    bpm: 120,
    sourceId,
    ...over,
  };
}

describe('buildScenePlan', () => {
  it('converts milliseconds to seconds throughout', () => {
    const plan = buildScenePlan(
      input({
        startPositionMs: 2500,
        tracks: [{ index: 0 }],
        clips: [
          {
            audioFileUri: 'file:///takes/a.wav',
            trackIndex: 0,
            offsetMs: 4000,
            trimStartMs: 500,
            trimEndMs: 3500,
          },
        ],
      }),
    );
    expect(plan.transport.originSec).toBe(2.5);
    const clip = plan.tracks[0]!.clips[0]!;
    expect(clip.offsetSec).toBe(4);
    expect(clip.trimStartSec).toBe(0.5);
    expect(clip.trimEndSec).toBe(3.5);
  });

  it('never copies a path into the plan', () => {
    // The rule the whole `sourceId` callback exists for. A plan is portable
    // between machines and a container path is not.
    const plan = buildScenePlan(
      input({
        tracks: [{ index: 0 }],
        clips: [
          { audioFileUri: 'file:///var/mobile/Containers/x/take3.wav', trackIndex: 0, offsetMs: 0, trimStartMs: 0, trimEndMs: null },
        ],
      }),
    );
    expect(plan.tracks[0]!.clips[0]!.source).toBe('take3.wav');
    expect(JSON.stringify(plan)).not.toContain('file://');
    expect(JSON.stringify(plan)).not.toContain('/var/');
  });

  it('refuses a clip it has no source id for', () => {
    // Silently dropping it is how a take goes missing between a project and a
    // playback that looks fine.
    expect(() =>
      buildScenePlan(
        input({
          sourceId: () => '',
          tracks: [{ index: 0 }],
          clips: [{ audioFileUri: 'x', trackIndex: 0, offsetMs: 0, trimStartMs: 0, trimEndMs: null }],
        }),
      ),
    ).toThrow(/no id for/);
  });

  it('keeps a declared track that has no clips', () => {
    // An armed track with nothing recorded still has a fader and still has to
    // appear. Taking tracks from the clips alone loses it.
    const plan = buildScenePlan(
      input({ tracks: [{ index: 0, volume: 0.5 }, { index: 1, muted: true }] }),
    );
    expect(plan.tracks.map((t) => t.index)).toEqual([0, 1]);
    expect(plan.tracks[0]!.volume).toBe(0.5);
    expect(plan.tracks[1]!.muted).toBe(true);
  });

  it('keeps a clip on a track nobody declared', () => {
    // A project inconsistency, and dropping it silently is worse than carrying
    // it at defaults where somebody can see it.
    const plan = buildScenePlan(
      input({
        tracks: [{ index: 0 }],
        clips: [{ audioFileUri: 'takes/b.wav', trackIndex: 7, offsetMs: 0, trimStartMs: 0, trimEndMs: null }],
      }),
    );
    expect(plan.tracks.map((t) => t.index)).toEqual([0, 7]);
    expect(plan.tracks[1]!.clips).toHaveLength(1);
  });

  it('reads a trim end at or before the start as unset', () => {
    const plan = buildScenePlan(
      input({
        tracks: [{ index: 0 }],
        clips: [
          { audioFileUri: 'a.wav', trackIndex: 0, offsetMs: 0, trimStartMs: 2000, trimEndMs: 2000 },
          { audioFileUri: 'a.wav', trackIndex: 0, offsetMs: 0, trimStartMs: 2000, trimEndMs: 1000 },
        ],
      }),
    );
    for (const clip of plan.tracks[0]!.clips) expect(clip.trimEndSec).toBeNull();
  });

  it('repairs a nonsense stretch ratio on the way in', () => {
    const plan = buildScenePlan(
      input({
        tracks: [{ index: 0 }],
        clips: [
          { audioFileUri: 'a.wav', trackIndex: 0, offsetMs: 0, trimStartMs: 0, trimEndMs: null, stretchRatio: 0 },
        ],
      }),
    );
    expect(plan.tracks[0]!.clips[0]!.stretchRatio).toBe(1);
  });

  it('converts warp segments from milliseconds', () => {
    const plan = buildScenePlan(
      input({
        tracks: [{ index: 0 }],
        clips: [
          {
            audioFileUri: 'a.wav',
            trackIndex: 0,
            offsetMs: 0,
            trimStartMs: 0,
            trimEndMs: null,
            warpSegments: [{ fileStartMs: 0, fileEndMs: 2000, ratio: 2, localOffsetMs: 500 }],
          },
        ],
      }),
    );
    expect(plan.tracks[0]!.clips[0]!.warpSegments).toEqual([
      { fileStartSec: 0, fileEndSec: 2, ratio: 2, localOffsetSec: 0.5 },
    ]);
  });

  it('sorts tracks and preserves clip order, so a plan built twice is identical', () => {
    // The render's summation order is part of the contract, so a builder that
    // reordered anything would make two builds of one project sound different
    // in the last bit.
    const built = () =>
      buildScenePlan(
        input({
          tracks: [{ index: 5 }, { index: 1 }, { index: 3 }],
          clips: [
            { audioFileUri: 'b.wav', trackIndex: 1, offsetMs: 2000, trimStartMs: 0, trimEndMs: null },
            { audioFileUri: 'a.wav', trackIndex: 1, offsetMs: 0, trimStartMs: 0, trimEndMs: null },
          ],
        }),
      );
    const first = built();
    expect(first.tracks.map((t) => t.index)).toEqual([1, 3, 5]);
    expect(first.tracks[0]!.clips.map((c) => c.source)).toEqual(['b.wav', 'a.wav']);
    expect(JSON.stringify(built())).toBe(JSON.stringify(first));
  });

  it('produces a plan that schedules and renders', () => {
    // The end of the arc, in one test: project shape in, audio out, through a
    // document that carried everything in between.
    const plan = buildScenePlan(
      input({
        startPositionMs: 1000,
        bpm: 100,
        master: { volume: 0.8 },
        tracks: [{ index: 0, volume: 0.5, automation: [] }],
        clips: [
          {
            audioFileUri: 'takes/one.wav',
            trackIndex: 0,
            offsetMs: 0,
            trimStartMs: 0,
            trimEndMs: 8000,
            clipGainDb: 0,
          },
        ],
      }),
    );

    const schedule = schedulePlan(plan, 0, () => 8);
    // Origin 1s: the clip started a second ago, so it reads from file 1s.
    expect(schedule.tracks[0]!.clips[0]!.windows[0]!.fileOffsetSec).toBe(1);
    expect(schedule.tracks[0]!.gain).toBe(0.5);

    // Keyed by the *plan's* source id, not the host's uri. Getting this wrong
    // renders silence rather than erroring, which is why `schedulePlan`
    // reports a decode span a host can check against what it actually has.
    const samples = renderPlan(plan, { 'one.wav': { kind: 'ramp', durationSec: 8 } }, {
      sampleRate: 4800,
      durationSec: 1,
    });
    // Ramp source: the sample states the file position, scaled by the two
    // faders. At half a second in, that is file position 1.5.
    expect(samples[Math.round(0.5 * 4800)]).toBeCloseTo(1.5 * 0.5 * 0.8, 5);
  });
});
