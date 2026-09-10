/**
 * Is `fixtures/session-conformance.json` still a description of this code?
 *
 * The staleness gate for slice 3. Two rules it exists to hold, both of which
 * this project has written down and could previously only enforce in one
 * language: beats are quarter-notes with the signature as two separate
 * numbers, and a lane writes nothing at all before it starts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SESSION_CONFORMANCE_FIXTURE_VERSION,
  buildSessionConformanceFixture,
  sessionFixtureStamp,
  type SessionConformanceFixture,
} from '../../src/automation/sessionConformance';
import { Easing } from '../../src/automation/Easing';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/session-conformance.json', import.meta.url));
const REGENERATE = 'npm run fixtures:session (from web-version/)';

function loadFixture(): SessionConformanceFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SessionConformanceFixture;
}

describe('session conformance fixture', () => {
  const onDisk = loadFixture();
  const rebuilt = buildSessionConformanceFixture();

  it('is not stale', () => {
    expect(
      onDisk.stamp,
      `fixtures/session-conformance.json no longer describes this code, so any ` +
        `other implementation of musical position or automation is being held ` +
        `to older rules and will pass regardless. Regenerate it: ${REGENERATE}`,
    ).toBe(rebuilt.stamp);
  });

  it('names the cases that changed, when it is stale', () => {
    const changed: string[] = [];
    for (const family of ['positions', 'lanes', 'lerps'] as const) {
      const before = new Map(onDisk[family].map((entry) => [entry.name, entry]));
      const after = new Map(rebuilt[family].map((entry) => [entry.name, entry]));
      for (const [name, entry] of after) {
        if (JSON.stringify(before.get(name)) !== JSON.stringify(entry)) changed.push(`${family}/${name}`);
      }
      for (const name of before.keys()) if (!after.has(name)) changed.push(`${family}/${name} (removed)`);
    }
    const scalarsChanged =
      JSON.stringify(onDisk.signatures) !== JSON.stringify(rebuilt.signatures) ||
      JSON.stringify(onDisk.easings) !== JSON.stringify(rebuilt.easings) ||
      JSON.stringify(onDisk.display127) !== JSON.stringify(rebuilt.display127);
    expect({ changed, scalarsChanged }).toEqual({ changed: [], scalarsChanged: false });
  });

  it('is self-consistent, so a hand-edited fixture is refused', () => {
    expect(sessionFixtureStamp(onDisk)).toBe(onDisk.stamp);
  });

  it('is a format this build understands', () => {
    expect(onDisk.version).toBe(SESSION_CONFORMANCE_FIXTURE_VERSION);
  });

  it('holds the time-signature rule where it is visible', () => {
    // Every one of these is 4 in 4/4, so a fixture without a compound or a
    // cut-time signature would be satisfied by folding the denominator into
    // the tempo, which is the documented mistake.
    const at = (n: number | null, d: number | null) =>
      onDisk.signatures.find((s) => s.beatsPerBar === n && s.beatUnit === d);
    expect(at(4, 4)?.bar).toBe(4);
    expect(at(6, 8)?.bar).toBe(3);
    expect(at(12, 8)?.bar).toBe(6);
    expect(at(2, 2)?.bar).toBe(4);
    expect(at(7, 8)?.bar).toBe(3.5);
    // Absent or nonsense means 4/4, the path every existing project takes.
    expect(at(null, null)?.bar).toBe(4);
    expect(at(0, 4)?.bar).toBe(4);
    expect(at(4, 0)?.bar).toBe(4);
    expect(at(4, -1)?.bar).toBe(4);
  });

  it('shows bar 3 landing somewhere different in 6/8 than in 4/4', () => {
    const four = onDisk.positions.find((p) => p.name === 'bar 3 in 4/4');
    const six = onDisk.positions.find((p) => p.name.startsWith('bar 3 in 6/8'));
    expect(four?.toBeats).toBe(8);
    expect(six?.toBeats).toBe(6);
  });

  it('records lanes that write nothing before they start', () => {
    // Returning a number where crate returns nothing overwrites whatever the
    // user set by hand. A fixture with no "no write" samples could not tell
    // the two apart.
    const silent = onDisk.lanes.flatMap((lane) => lane.samples.filter((s) => s.value === null));
    const written = onDisk.lanes.flatMap((lane) => lane.samples.filter((s) => s.value !== null));
    expect(silent.length).toBeGreaterThan(10);
    expect(written.length).toBeGreaterThan(30);
  });

  it('separates hold from stop at the end of a lane', () => {
    const held = onDisk.lanes.find((l) => l.name === 'linear ramp, held after the end');
    const stopped = onDisk.lanes.find((l) => l.name.includes('not held'));
    const at = (lane: typeof held, t: number) => lane?.samples.find((s) => s.timelineSec === t)?.value;
    expect(at(held, 5)).toBe(1);
    expect(at(stopped, 5)).toBeNull();
  });

  it('lets baked points override shape, from and to', () => {
    // A lane with points is authored output. A port that still applied
    // from/to would scale somebody's drawn curve by 99.
    const lane = onDisk.lanes.find((l) => l.name.startsWith('baked points'));
    expect(lane?.from).toBe(99);
    expect(lane?.to).toBe(-99);
    for (const sample of lane!.samples) {
      if (sample.value === null) continue;
      expect(sample.value).toBeGreaterThanOrEqual(10);
      expect(sample.value).toBeLessThanOrEqual(80);
    }
  });

  it('marks exactly the easings that reach pow or sin', () => {
    const transcendental = new Set(['exp', 'log', 'swell']);
    for (const probe of onDisk.easings) expect(probe.exact).toBe(!transcendental.has(probe.name));
    // And every shipped easing is probed, so adding one without a case fails.
    const names = new Set(onDisk.easings.map((probe) => probe.name));
    expect([...names].sort()).toEqual(Object.keys(Easing).sort());
  });

  it('clamps easing progress rather than extrapolating', () => {
    for (const name of Object.keys(Easing)) {
      const below = onDisk.easings.find((e) => e.name === name && e.u === -0.5);
      const above = onDisk.easings.find((e) => e.name === name && e.u === 1.5);
      expect(below?.value, name).toBe(Easing[name as keyof typeof Easing](0));
      expect(above?.value, name).toBe(Easing[name as keyof typeof Easing](1));
    }
  });
});
