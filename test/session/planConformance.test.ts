/**
 * Is `fixtures/plan-conformance.json` still a description of this code?
 *
 * The staleness gate for slice 4. This one guards a composition rather than a
 * function: the tempo map, clip placement and automation are each already held
 * to their own fixture, and a host can still wire them together wrongly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLAN_CONFORMANCE_FIXTURE_VERSION,
  buildPlanConformanceFixture,
  planFixtureStamp,
  type PlanConformanceFixture,
} from '../../src/session/planConformance';
import { SCENE_PLAN_VERSION } from '../../src/session/ScenePlan';
import { renderPlan } from '../../src/session/planRender';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/plan-conformance.json', import.meta.url));
const REGENERATE = 'npm run fixtures:plan (from web-version/)';

function loadFixture(): PlanConformanceFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PlanConformanceFixture;
}

describe('scene plan fixture', () => {
  const onDisk = loadFixture();
  const rebuilt = buildPlanConformanceFixture();

  it('is not stale', () => {
    expect(
      onDisk.stamp,
      `fixtures/plan-conformance.json no longer describes this code, so any ` +
        `host executing a plan is held to older scheduling and will pass ` +
        `regardless. Regenerate it: ${REGENERATE}`,
    ).toBe(rebuilt.stamp);
  });

  it('names the plans that changed, when it is stale', () => {
    const before = new Map(onDisk.cases.map((entry) => [entry.name, entry]));
    const after = new Map(rebuilt.cases.map((entry) => [entry.name, entry]));
    const changed = [...after.keys()].filter(
      (name) => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)),
    );
    const removed = [...before.keys()].filter((name) => !after.has(name));
    expect({ changed, removed }).toEqual({ changed: [], removed: [] });
  });

  it('is self-consistent, so a hand-edited fixture is refused', () => {
    expect(planFixtureStamp(onDisk)).toBe(onDisk.stamp);
  });

  it('states both formats it depends on', () => {
    // The fixture format and the plan format move independently: a case can
    // be added without changing what a plan is, and a plan field can be added
    // without changing how cases are recorded.
    expect(onDisk.version).toBe(PLAN_CONFORMANCE_FIXTURE_VERSION);
    expect(onDisk.planVersion).toBe(SCENE_PLAN_VERSION);
    for (const entry of onDisk.cases) expect(entry.plan.version).toBe(SCENE_PLAN_VERSION);
  });

  it('applies the transport origin exactly once', () => {
    // Origin 4 with a clip at offset 4: at probe 0 the clip must start
    // immediately from the top of its source. Applying the origin twice puts
    // the playhead at 8 and starts the clip four seconds in; forgetting it
    // puts the playhead at 0 and the clip four seconds away.
    const entry = onDisk.cases.find((c) => c.name.startsWith('the transport origin'));
    const first = entry!.schedules[0]!;
    expect(first.atBeats).toBe(8);
    const clip = first.tracks[0]!.clips[0]!;
    expect(clip.windows[0]?.whenSec).toBe(0);
    expect(clip.windows[0]?.fileOffsetSec).toBe(0);
  });

  it('resolves automation through the tempo map rather than a bare bpm', () => {
    // The composition bug this whole fixture exists for. A lane over beats
    // 2..8 with a tempo change at beat 4 spans 1s..6s, so 2s is u=0.2. Using
    // the transport's bpm instead gives 0.333, which is wrong and plausible.
    const entry = onDisk.cases.find((c) => c.name.startsWith('automation resolves'));
    const atTwo = entry!.schedules[entry!.probes.indexOf(2)]!;
    expect(atTwo.tracks[0]!.automation.volume).toBeCloseTo(0.2, 12);
    expect(atTwo.bpm).toBe(60);
  });

  it('reports a decode span narrower than the clip once the playhead is inside it', () => {
    // Decoding a whole take to play its last two seconds is the difference
    // between starting instantly and not, so the span is derived from the
    // windows rather than from the trim.
    const entry = onDisk.cases.find((c) => c.name === 'one clip at the origin');
    const atZero = entry!.schedules[0]!.tracks[0]!.clips[0]!;
    const atTwo = entry!.schedules[1]!.tracks[0]!.clips[0]!;
    expect(atZero.decodeStartSec).toBe(0);
    expect(atTwo.decodeStartSec).toBe(2);
    expect(atTwo.decodeEndSec).toBe(atZero.decodeEndSec);
  });

  it('makes a muted track exactly zero and a muted clip silent', () => {
    const entry = onDisk.cases.find((c) => c.name.startsWith('a muted clip'));
    const schedule = entry!.schedules[0]!;
    expect(schedule.tracks[0]!.clips[0]!.windows).toHaveLength(0);
    expect(schedule.tracks[1]!.gain).toBe(0);
    // The unmuted clip on the muted track still schedules: muting a track is
    // a fader, not a reason to stop tracking where its clips are.
    expect(schedule.tracks[1]!.clips[0]!.windows.length).toBeGreaterThan(0);
  });

  it('treats an unknown source as silent rather than fatal', () => {
    const entry = onDisk.cases.find((c) => c.name.startsWith('a source the host does not know'));
    const clips = entry!.schedules[0]!.tracks[0]!.clips;
    expect(clips[0]!.windows).toHaveLength(0);
    expect(clips[0]!.decodeStartSec).toBeNull();
    expect(clips[1]!.windows.length).toBeGreaterThan(0);
  });

  it('schedules something, so an implementation that returns nothing fails', () => {
    const windows = onDisk.cases.flatMap((entry) =>
      entry.schedules.flatMap((schedule) =>
        schedule.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.windows)),
      ),
    );
    expect(windows.length).toBeGreaterThan(30);
  });

  it('renders audio, not just schedules', () => {
    // Every silent case agrees with a renderer that outputs nothing, so the
    // audible half has to be present for the comparison to mean anything.
    const audible = onDisk.cases.flatMap((entry) => entry.render.filter((v) => v !== 0));
    expect(audible.length).toBeGreaterThan(20000);
    expect(onDisk.renderSampleRate).toBeGreaterThan(0);
    for (const entry of onDisk.cases) {
      expect(entry.render.length, entry.name).toBe(onDisk.renderSampleRate * onDisk.renderSeconds);
    }
  });

  it('makes a rendered sample state the file position it came from', () => {
    // The ramp source is chosen, not arbitrary: sample(t) = t, so a placement
    // error prints as a wrong number instead of a different-looking waveform.
    const entry = onDisk.cases.find((c) => c.name === 'one clip at the origin');
    const sr = onDisk.renderSampleRate;
    for (const t of [0, 0.25, 0.5, 1, 1.5]) {
      expect(entry!.render[Math.round(t * sr)], `t=${t}`).toBeCloseTo(t, 5);
    }
  });

  it('reads a stretched clip at the stretched rate', () => {
    // trim 1..5 at ratio 2 plays back at rate 0.5, so one timeline second is
    // half a file second and the rendered value advances at half speed.
    const entry = onDisk.cases.find((c) => c.name === 'a trimmed and stretched clip');
    const sr = onDisk.renderSampleRate;
    for (const t of [0, 0.5, 1, 1.9]) {
      expect(entry!.render[Math.round(t * sr)], `t=${t}`).toBeCloseTo(1 + t * 0.5, 5);
    }
  });

  it('keeps a stretched window audible for its whole timeline extent', () => {
    // The case that exists because every other stretched clip here outlasts
    // the render window, which let `fileDuration * rate` hide.
    const entry = onDisk.cases.find((c) => c.name.startsWith('a short clip stretched threefold'));
    const sr = onDisk.renderSampleRate;
    expect(entry!.render[Math.round(1.4 * sr)]).toBeGreaterThan(0);
    expect(entry!.render[Math.round(1.6 * sr)]).toBe(0);
  });

  it('sums overlapping clips rather than replacing', () => {
    const entry = onDisk.cases.find((c) => c.name.startsWith('two clips overlapping'));
    const sr = onDisk.renderSampleRate;
    // At 1.5s clip a reads file 1.5 and clip b, one second later, reads 0.5.
    expect(entry!.render[Math.round(1.5 * sr)]).toBeCloseTo(2, 5);
  });

  it('renders silence where silence is the answer', () => {
    for (const name of [
      'empty plan',
      'a muted clip is silent and a muted track is gain zero',
      'a source with a length but no samples renders silence',
    ]) {
      const entry = onDisk.cases.find((c) => c.name === name);
      expect(entry!.render.every((v) => v === 0), name).toBe(true);
    }
  });

  it('records what renderPlan actually produces', () => {
    // The stamp already covers this, but a mismatch here names the case and
    // the frame instead of printing two hashes.
    for (const entry of onDisk.cases) {
      const actual = renderPlan(entry.plan, entry.sourceSpecs, {
        sampleRate: onDisk.renderSampleRate,
        durationSec: onDisk.renderSeconds,
        atSec: entry.probes[0] ?? 0,
      });
      let worst = 0;
      let worstFrame = -1;
      for (let i = 0; i < actual.length; i++) {
        const diff = Math.abs(actual[i]! - entry.render[i]!);
        if (diff > worst) {
          worst = diff;
          worstFrame = i;
        }
      }
      expect(worst, `${entry.name} at frame ${worstFrame}`).toBe(0);
    }
  });

  it('carries no file path anywhere', () => {
    // A plan names sources by id. A path is portable to exactly one container
    // on exactly one device, which is what `deviceId` already taught us.
    const json = JSON.stringify(onDisk);
    expect(json).not.toMatch(/file:\/\//);
    expect(json).not.toMatch(/\/(var|Users|storage|data)\//);
  });
});
