/**
 * Is `fixtures/motion-conformance.json` still a description of the palette?
 *
 * The native side replays it against the bundled catalog, so a stale fixture
 * holds Swift to how the palette used to move and it passes regardless.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildMotionFixture, motionFixtureStamp, type MotionFixture } from '../src/motionConformance';
import { buildMaterialCatalog } from '../src/materialCatalog';

const here = dirname(fileURLToPath(import.meta.url));
const onDisk = JSON.parse(
  readFileSync(resolve(here, '../../fixtures/motion-conformance.json'), 'utf8'),
) as MotionFixture;

describe('motion conformance fixture', () => {
  const rebuilt = buildMotionFixture();

  it('is not stale', () => {
    expect(onDisk.stamp, 'motion-conformance.json is stale: run `npm run fixtures:motion` from web-version/').toBe(
      rebuilt.stamp,
    );
  });

  it('is self-consistent, so a hand-edited fixture is refused', () => {
    expect(motionFixtureStamp(onDisk)).toBe(onDisk.stamp);
  });

  it('covers every palette material, and says why any is left out', () => {
    const kinds = buildMaterialCatalog().materials.map((m) => m.kind).sort();
    const covered = [...onDisk.cases.map((c) => c.kind), ...onDisk.silent].sort();
    expect(covered).toEqual(kinds);
    // Silence is allowed only where there is nothing to hear without a
    // sample, a sidechain or a transient. A material joining this list means
    // it stopped making sound, which is a regression, not a fixture detail.
    expect(onDisk.silent).toEqual(['onset', 'sampleplayer', 'sidechaingate']);
  });

  it('actually moves: every case has parameter events and a retrigger', () => {
    for (const entry of onDisk.cases) {
      expect(entry.events.filter((e) => e.params).length, entry.kind).toBeGreaterThanOrEqual(4);
      expect(entry.events.some((e) => e.note === 'off'), entry.kind).toBe(true);
      expect(entry.events.some((e) => e.note === 'on'), entry.kind).toBe(true);
    }
  });
});
