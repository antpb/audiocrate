/**
 * The scene plan fixture, as a value.
 *
 * Slice 4, and the one that ties the other three together. A plan goes in, a
 * sample-accurate schedule comes out, and the schedule is what a host acts on.
 * Everything the previous fixtures hold in isolation is exercised here in
 * composition: the tempo map places the playhead, clip placement resolves what
 * plays, and the automation lanes resolve what every parameter is worth.
 *
 * Composition is the point. Each of `TempoMap`, `clipPlaybackWindows` and
 * `AutomationLane` is already held to a fixture, and a host can still wire
 * them together wrongly: applying the transport origin twice, resolving
 * automation against the wrong clock, or forgetting that a plan's positions
 * are relative to a timeline and its playhead is not. Only a fixture over the
 * whole function can see those.
 *
 * All of it is arithmetic over the ported pieces, so every schedule is
 * compared **with no tolerance at all** except where a tempo ramp or a
 * transcendental easing is in the way, which each plan states.
 */
import {
  SCENE_PLAN_VERSION,
  schedulePlan,
  type PlanSchedule,
  type ScenePlan,
} from './ScenePlan';
import { renderPlan, type PlanSourceSpec } from './planRender';

/**
 * Bumped when the shape changes, not when the scheduling does.
 *
 * 1: plans, source durations, probe instants, schedules.
 * 2: rendered audio, so the two implementations are compared as sound and not
 *    only as numbers.
 */
export const PLAN_CONFORMANCE_FIXTURE_VERSION = 2;

/**
 * The render is deliberately low rate and short.
 *
 * 4800 Hz and two seconds is 9,600 frames per case, which is small enough to
 * check into a fixture and fine enough that a one-frame placement error is one
 * wrong sample rather than a rounding. The rate has nothing to do with audio
 * quality here: the sources are formulas, and what is being compared is where
 * they were read from.
 */
export const PLAN_RENDER_SAMPLE_RATE = 4800;
export const PLAN_RENDER_SECONDS = 2;

/** Deviation allowed on a plan that ramps tempo or uses a transcendental easing. */
export const PLAN_TOLERANCE = 1e-12;

export interface PlanCase {
  name: string;
  plan: ScenePlan;
  /** Source id to length in seconds. A source not listed is unknown to the host. */
  sources: Record<string, number>;
  /**
   * The same sources as formulas, for the render.
   *
   * A source listed in `sources` but not here has a length and no samples,
   * which is a host that knows how long a take is but cannot produce it. That
   * is a real state and it renders silence.
   */
  sourceSpecs: Record<string, PlanSourceSpec>;
  /** Mono samples from the plan's playhead. Empty when the case renders nothing. */
  render: number[];
  /** Instants relative to the plan's transport origin. */
  probes: number[];
  schedules: PlanSchedule[];
  exact: boolean;
}

export interface PlanConformanceFixture {
  note: string;
  version: number;
  stamp: string;
  planVersion: number;
  tolerance: number;
  renderSampleRate: number;
  renderSeconds: number;
  cases: PlanCase[];
}

function lane(target: string, over: Partial<PlanCase['plan']['tracks'][number]['automation'][number]> = {}) {
  return {
    target,
    startBeats: 0,
    endBeats: 8,
    from: 0,
    to: 1,
    shape: 'linear' as const,
    points: null,
    chase: true,
    hold: true,
    invert: false,
    ...over,
  };
}

function clip(id: string, source: string, over: Partial<PlanCase['plan']['tracks'][number]['clips'][number]> = {}) {
  return {
    id,
    source,
    offsetSec: 0,
    trimStartSec: 0,
    trimEndSec: null as number | null,
    stretchRatio: 1,
    warpSegments: null,
    gainDb: 0,
    muted: false,
    ...over,
  };
}

function track(index: number, over: Partial<PlanCase['plan']['tracks'][number]> = {}) {
  return {
    index,
    volume: 1,
    pan: 0,
    muted: false,
    latencySamples: 0,
    clips: [],
    automation: [],
    ...over,
  };
}

function plan(over: Partial<ScenePlan> = {}): ScenePlan {
  return {
    version: SCENE_PLAN_VERSION,
    transport: { originSec: 0, bpm: 120, ppqn: 960, tempoChanges: null },
    master: { volume: 1, latencySamples: 0 },
    tracks: [],
    ...over,
  };
}

/**
 * A ramp whose sample at file position `t` is `t`, so a rendered sample states
 * where it was read from. The default for every case, because placement is
 * what a plan contributes and a ramp makes a placement error legible.
 */
function ramp(durationSec: number): PlanSourceSpec {
  return { kind: 'ramp', durationSec };
}

const CASE_INPUTS: Array<{
  name: string;
  plan: ScenePlan;
  sources: Record<string, number>;
  /** Defaults to a ramp per entry in `sources`. */
  sourceSpecs?: Record<string, PlanSourceSpec>;
  probes: number[];
  exact?: boolean;
}> = [
  {
    name: 'empty plan',
    plan: plan(),
    sources: {},
    probes: [0, 1],
  },
  {
    name: 'one clip at the origin',
    plan: plan({ tracks: [track(0, { clips: [clip('c1', 'take-a')] })] }),
    sources: { 'take-a': 8 },
    probes: [0, 2, 8, 9],
  },
  {
    name: 'a clip later on the timeline',
    plan: plan({ tracks: [track(0, { clips: [clip('c1', 'take-a', { offsetSec: 4 })] })] }),
    sources: { 'take-a': 8 },
    probes: [0, 3, 4, 6],
  },
  {
    name: 'the transport origin moves the playhead, and is not applied twice',
    plan: plan({
      transport: { originSec: 4, bpm: 120, ppqn: 960, tempoChanges: null },
      tracks: [track(0, { clips: [clip('c1', 'take-a', { offsetSec: 4 })] })],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 1, 4],
  },
  {
    name: 'a muted clip is silent and a muted track is gain zero',
    plan: plan({
      tracks: [
        track(0, { clips: [clip('c1', 'take-a', { muted: true })] }),
        track(1, { muted: true, volume: 0.8, clips: [clip('c2', 'take-a')] }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 1],
  },
  {
    name: 'clip gain in dB becomes a linear multiplier',
    plan: plan({
      tracks: [
        track(0, {
          volume: 0.5,
          clips: [clip('c1', 'take-a', { gainDb: -6 }), clip('c2', 'take-a', { gainDb: -60, offsetSec: 4 })],
        }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 5],
    exact: false,
  },
  {
    name: 'a trimmed and stretched clip',
    plan: plan({
      tracks: [
        track(0, {
          clips: [clip('c1', 'take-a', { trimStartSec: 1, trimEndSec: 5, stretchRatio: 2 })],
        }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 2, 7, 9],
  },
  {
    name: 'a warped clip, playhead inside the second segment',
    plan: plan({
      tracks: [
        track(0, {
          clips: [
            clip('c1', 'take-a', {
              warpSegments: [
                { fileStartSec: 0, fileEndSec: 2, ratio: 1, localOffsetSec: 0 },
                { fileStartSec: 2, fileEndSec: 4, ratio: 2, localOffsetSec: 2 },
              ],
            }),
          ],
        }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 1, 3, 5, 7],
  },
  {
    name: 'a source the host does not know is silent, not fatal',
    plan: plan({
      tracks: [track(0, { clips: [clip('c1', 'missing'), clip('c2', 'take-a', { offsetSec: 2 })] })],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 3],
  },
  {
    name: 'automation writes only inside its range',
    plan: plan({
      tracks: [
        track(0, {
          clips: [clip('c1', 'take-a')],
          automation: [
            lane('volume', { startBeats: 2, endBeats: 6, from: 0.2, to: 0.9 }),
            lane('cutoff', { startBeats: 0, endBeats: 4, from: 200, to: 8000, hold: false }),
          ],
        }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 0.5, 1, 2, 3, 4],
  },
  {
    name: 'automation resolves against a tempo map, not a bare bpm',
    plan: plan({
      transport: {
        originSec: 0,
        bpm: 120,
        ppqn: 960,
        tempoChanges: [{ atBeat: 4, bpm: 60, curve: 'jump' }],
      },
      tracks: [
        track(0, {
          clips: [clip('c1', 'take-a')],
          automation: [lane('volume', { startBeats: 2, endBeats: 8 })],
        }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 1, 2, 4, 6],
  },
  {
    name: 'a ramped tempo map moves the reported bpm',
    plan: plan({
      transport: {
        originSec: 0,
        bpm: 90,
        ppqn: 960,
        tempoChanges: [
          { atBeat: 0, bpm: 90, curve: 'ramp' },
          { atBeat: 8, bpm: 160, curve: 'jump' },
        ],
      },
      tracks: [track(0, { clips: [clip('c1', 'take-a')] })],
    }),
    sources: { 'take-a': 8 },
    probes: [0, 1, 3, 5],
    exact: false,
  },
  {
    name: 'insert latency travels with the track',
    plan: plan({
      master: { volume: 0.75, latencySamples: 512 },
      tracks: [
        track(0, { latencySamples: 1024, clips: [clip('c1', 'take-a')] }),
        track(1, { latencySamples: 0, clips: [clip('c2', 'take-a')] }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0],
  },
  {
    name: 'stepped source, where a misread lands on a different plateau',
    plan: plan({
      tracks: [
        track(0, {
          clips: [clip('c1', 'take-s', { offsetSec: 0.5, stretchRatio: 2 })],
        }),
      ],
    }),
    sources: { 'take-s': 4 },
    sourceSpecs: { 'take-s': { kind: 'steps', durationSec: 4, stepSec: 0.25 } },
    probes: [0],
  },
  {
    name: 'a sine source, the one case that looks like audio',
    plan: plan({
      tracks: [track(0, { volume: 0.5, clips: [clip('c1', 'take-t')] })],
    }),
    sources: { 'take-t': 4 },
    sourceSpecs: { 'take-t': { kind: 'sine', durationSec: 4, hz: 110 } },
    probes: [0],
    exact: false,
  },
  {
    name: 'a source with a length but no samples renders silence',
    plan: plan({ tracks: [track(0, { clips: [clip('c1', 'lengthy')] })] }),
    sources: { lengthy: 8 },
    sourceSpecs: {},
    probes: [0],
  },
  {
    name: 'two clips overlapping sum into one bus',
    plan: plan({
      tracks: [
        track(0, { clips: [clip('a', 'take-a', { trimEndSec: 3 })] }),
        track(1, { clips: [clip('b', 'take-a', { offsetSec: 1, trimEndSec: 3 })] }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0],
  },
  {
    name: 'a short clip stretched threefold, so its extent is inside the render',
    // Aimed at one specific mistake: computing a window's timeline extent as
    // `fileDuration * rate` rather than `/ rate`. Every other stretched case
    // here has an extent longer than the render, so the wrong formula truncates
    // at or past the end and hides. This one is 0.5 file seconds at ratio 3:
    // 1.5s of timeline if right, 0.167s if wrong, both well inside the window.
    plan: plan({
      tracks: [
        track(0, { clips: [clip('c1', 'take-a', { trimEndSec: 0.5, stretchRatio: 3 })] }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0],
  },
  {
    name: 'three tracks under a master gain that rounds',
    // Aimed at the summation order. `(a + b + c) * g` and
    // `a*g + b*g + c*g` are the same number when g is 1 or a power of two,
    // which every other case here uses, so a renderer that folded the master
    // gain into each contribution would pass them all. 0.3 is neither.
    plan: plan({
      master: { volume: 0.3, latencySamples: 0 },
      tracks: [
        track(0, { volume: 0.7, clips: [clip('a', 'take-a', { trimEndSec: 3 })] }),
        track(1, { volume: 0.31, clips: [clip('b', 'take-a', { offsetSec: 0.1, trimEndSec: 3 })] }),
        track(2, { volume: 0.9, clips: [clip('c', 'take-a', { offsetSec: 0.23, trimEndSec: 3 })] }),
      ],
    }),
    sources: { 'take-a': 8 },
    probes: [0],
  },
  {
    name: 'several tracks at once',
    plan: plan({
      tracks: [
        track(0, { volume: 0.9, pan: -0.5, clips: [clip('a', 'take-a')] }),
        track(1, { volume: 0.4, pan: 0.25, clips: [clip('b', 'take-b', { offsetSec: 1 })] }),
        track(2, { volume: 1, clips: [] }),
      ],
    }),
    sources: { 'take-a': 8, 'take-b': 3 },
    probes: [0, 2, 4.5],
  },
];

export function planFixtureStamp(
  fixture: Omit<PlanConformanceFixture, 'stamp'> & { stamp?: string },
): string {
  const body = JSON.stringify([
    fixture.version,
    fixture.planVersion,
    fixture.tolerance,
    fixture.renderSampleRate,
    fixture.renderSeconds,
    fixture.cases,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildPlanConformanceFixture(): PlanConformanceFixture {
  const cases: PlanCase[] = CASE_INPUTS.map((entry) => {
    const specs =
      entry.sourceSpecs ??
      Object.fromEntries(Object.entries(entry.sources).map(([id, length]) => [id, ramp(length)]));
    return {
      name: entry.name,
      plan: entry.plan,
      sources: { ...entry.sources },
      sourceSpecs: specs,
      probes: [...entry.probes],
      schedules: entry.probes.map((at) =>
        schedulePlan(entry.plan, at, (source) => entry.sources[source]),
      ),
      // Rendered from the first probe, which is the playhead a host would
      // actually start at.
      render: Array.from(
        renderPlan(entry.plan, specs, {
          sampleRate: PLAN_RENDER_SAMPLE_RATE,
          durationSec: PLAN_RENDER_SECONDS,
          atSec: entry.probes[0] ?? 0,
        }),
      ),
      exact: entry.exact ?? true,
    };
  });

  const fixture: Omit<PlanConformanceFixture, 'stamp'> = {
    note: 'Generated by scripts/emit-plan-fixtures.ts. Do not edit by hand: run `npm run fixtures:plan`.',
    version: PLAN_CONFORMANCE_FIXTURE_VERSION,
    planVersion: SCENE_PLAN_VERSION,
    tolerance: PLAN_TOLERANCE,
    renderSampleRate: PLAN_RENDER_SAMPLE_RATE,
    renderSeconds: PLAN_RENDER_SECONDS,
    cases,
  };
  return { ...fixture, stamp: planFixtureStamp(fixture) };
}
