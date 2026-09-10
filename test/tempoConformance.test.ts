/**
 * Is `fixtures/tempo-conformance.json` still a description of this code?
 *
 * Same job as the ASL and MIDI staleness gates, for the first slice of the
 * session layer. A native host that places a clip does it by asking a tempo
 * map what second a beat falls on; if this fixture goes stale, that host is
 * held to the map as it used to be and every clip in a project with a tempo
 * change lands somewhere else.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TEMPO_CONFORMANCE_FIXTURE_VERSION,
  buildTempoConformanceFixture,
  tempoFixtureStamp,
  type TempoConformanceFixture,
} from '../src/tempoConformance';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/tempo-conformance.json', import.meta.url));
const REGENERATE = 'npm run fixtures:tempo (from web-version/)';

function loadFixture(): TempoConformanceFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as TempoConformanceFixture;
}

describe('tempo conformance fixture', () => {
  const onDisk = loadFixture();
  const rebuilt = buildTempoConformanceFixture();

  it('is not stale', () => {
    expect(
      onDisk.stamp,
      `fixtures/tempo-conformance.json no longer describes this code, so any ` +
        `other implementation of TempoMap is being held to an older contract ` +
        `and will pass regardless. Regenerate it: ${REGENERATE}`,
    ).toBe(rebuilt.stamp);
  });

  it('names the maps that changed, when it is stale', () => {
    const before = new Map(onDisk.maps.map((entry) => [entry.name, entry]));
    const after = new Map(rebuilt.maps.map((entry) => [entry.name, entry]));
    const changed = [...after.keys()].filter(
      (name) => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)),
    );
    const removed = [...before.keys()].filter((name) => !after.has(name));
    expect({ changed, removed }).toEqual({ changed: [], removed: [] });
  });

  it('is self-consistent, so a hand-edited fixture is refused', () => {
    expect(tempoFixtureStamp(onDisk)).toBe(onDisk.stamp);
  });

  it('is a format this build understands', () => {
    expect(onDisk.version).toBe(TEMPO_CONFORMANCE_FIXTURE_VERSION);
  });

  it('carries maps that are held to the bit, and says which', () => {
    // Without at least one exact map the whole fixture could be satisfied by
    // an implementation that pre-divides, which moves every clip by a
    // rounding. That is the specific bug TempoMap.ts is arranged to prevent.
    const exact = onDisk.maps.filter((entry) => entry.exact);
    expect(exact.length).toBeGreaterThan(4);
    // `exact` and `hasRamps` are the same statement seen from two sides, and
    // a reader on the other side keys its tolerance off `exact`.
    for (const entry of onDisk.maps) expect(entry.exact).toBe(!entry.hasRamps);
  });

  it('records the pre-divide probe, and it still disagrees', () => {
    // 129.7 beats at 174 bpm is the pair where `(b * 60) / bpm` and
    // `b * (60 / bpm)` differ in the last bit. If this ever stops being true
    // the probe has stopped probing anything and should be replaced.
    expect((129.7 * 60) / 174).not.toBe(129.7 * (60 / 174));
    const map = onDisk.maps.find((entry) => entry.name.includes('pre-divide'));
    const probe = map?.queries.find((query) => query.at === 129.7);
    expect(probe?.secondsAtBeat).toBe((129.7 * 60) / 174);
  });

  it('records a ramp that is not the average of its endpoints', () => {
    // A ramp from 60 to 120 over four beats takes 2.77 seconds, not the 2.67
    // an average gives: the slow end lasts longer. An implementation that
    // averages passes every constant case and fails here.
    const map = onDisk.maps.find((entry) => entry.name.includes('accelerando'));
    const atFour = map?.queries.find((query) => query.at === 4)?.secondsAtBeat ?? 0;
    expect(atFour).toBeGreaterThan(2.77);
    expect(atFour).toBeLessThan(2.78);
  });

  it('round trips within the tolerance it states', () => {
    for (const map of onDisk.maps) {
      for (const trip of map.roundTrips) {
        expect(Math.abs(trip.back - trip.beat), `${map.name} @ ${trip.beat}`).toBeLessThanOrEqual(
          onDisk.roundTripTolerance,
        );
      }
    }
  });

  it('probes below the origin, where clamping would hide the bug', () => {
    // A negative beat extrapolates backwards rather than clamping to zero.
    // An implementation with a max(0, ...) in it passes everything else.
    for (const map of onDisk.maps) {
      const back = map.queries.find((query) => query.at === -4);
      expect(back, map.name).toBeDefined();
      expect(back!.secondsAtBeat, map.name).toBeLessThan(0);
    }
  });
});
