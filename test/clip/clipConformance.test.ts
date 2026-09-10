/**
 * Is `fixtures/clip-conformance.json` still a description of this code?
 *
 * The staleness gate for slice 2 of the session layer. If this goes stale, a
 * native host is held to the placement rules as they used to be, and a clip
 * plays the wrong part of the take rather than failing loudly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIP_CONFORMANCE_FIXTURE_VERSION,
  buildClipConformanceFixture,
  clipFixtureStamp,
  type ClipConformanceFixture,
} from '../../src/clip/clipConformance';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/clip-conformance.json', import.meta.url));
const REGENERATE = 'npm run fixtures:clip (from web-version/)';

function loadFixture(): ClipConformanceFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ClipConformanceFixture;
}

describe('clip conformance fixture', () => {
  const onDisk = loadFixture();
  const rebuilt = buildClipConformanceFixture();

  it('is not stale', () => {
    expect(
      onDisk.stamp,
      `fixtures/clip-conformance.json no longer describes this code, so any ` +
        `other implementation of clip placement is being held to older rules ` +
        `and will pass regardless. Regenerate it: ${REGENERATE}`,
    ).toBe(rebuilt.stamp);
  });

  it('names the cases that changed, when it is stale', () => {
    const changed: string[] = [];
    for (const family of ['windows', 'durations', 'trims', 'warpConversions'] as const) {
      const before = new Map(onDisk[family].map((entry) => [entry.name, entry]));
      const after = new Map(rebuilt[family].map((entry) => [entry.name, entry]));
      for (const [name, entry] of after) {
        if (JSON.stringify(before.get(name)) !== JSON.stringify(entry)) changed.push(`${family}/${name}`);
      }
      for (const name of before.keys()) if (!after.has(name)) changed.push(`${family}/${name} (removed)`);
    }
    const shapesChanged =
      JSON.stringify(onDisk.fades) !== JSON.stringify(rebuilt.fades) ||
      JSON.stringify(onDisk.gains) !== JSON.stringify(rebuilt.gains);
    expect({ changed, shapesChanged }).toEqual({ changed: [], shapesChanged: false });
  });

  it('is self-consistent, so a hand-edited fixture is refused', () => {
    expect(clipFixtureStamp(onDisk)).toBe(onDisk.stamp);
  });

  it('is a format this build understands', () => {
    expect(onDisk.version).toBe(CLIP_CONFORMANCE_FIXTURE_VERSION);
  });

  it('emits windows, so an implementation that returns nothing fails', () => {
    // Every "yields nothing" case is satisfied by a function that always
    // returns an empty list, which is the most likely way for a port to be
    // wrong and still green.
    const emitted = onDisk.windows.reduce((total, entry) => total + entry.windows.length, 0);
    expect(emitted).toBeGreaterThan(12);
    const silent = onDisk.windows.filter((entry) => entry.windows.length === 0);
    expect(silent.length).toBeGreaterThan(1);
    expect(silent.length).toBeLessThan(onDisk.windows.length / 2);
  });

  it('covers a playhead landing inside a warp segment', () => {
    // Skipping into the file and skipping into the timeline differ by the
    // ratio, and only one of them is right. A case where the ratio is 1 could
    // not tell them apart.
    const entry = onDisk.windows.find((w) => w.name === 'playhead inside the second warp segment');
    expect(entry?.windows).toHaveLength(1);
    expect(entry?.windows[0]?.fileOffsetSec).toBe(2.5);
    expect(entry?.windows[0]?.fileDurationSec).toBe(1.5);
    expect(entry?.windows[0]?.playbackRate).toBe(0.5);
  });

  it('states a playback rate that is the reciprocal of the stretch ratio', () => {
    // Confusing the two is inaudible on an unstretched clip and doubles the
    // pitch of a stretched one.
    for (const entry of onDisk.windows) {
      if (entry.warpSegments && entry.warpSegments.length > 0) continue;
      const ratio = Number.isFinite(entry.stretchRatio) && entry.stretchRatio > 0 ? entry.stretchRatio : 1;
      for (const window of entry.windows) expect(window.playbackRate).toBeCloseTo(1 / ratio, 12);
    }
  });

  it('marks exactly the cases that reach sin or pow', () => {
    // A reader on the other side keys its tolerance off `exact`, so a case
    // marked wrong is either a false failure or an unchecked one.
    for (const probe of onDisk.fades) expect(probe.exact).toBe(probe.curve !== 'equalPower');
    for (const probe of onDisk.gains) expect(probe.exact).toBe(!(probe.db > -60));
  });

  it('puts the silence floor exactly at -60 dB', () => {
    const at = (db: number) => onDisk.gains.find((g) => g.db === db)?.linear;
    expect(at(-60)).toBe(0);
    expect(at(-60.1)).toBe(0);
    expect(at(-59.9)).toBeGreaterThan(0);
  });

  it('clamps fade progress outside 0..1 rather than extrapolating', () => {
    for (const curve of ['linear', 'equalPower', 'sCurve']) {
      const below = onDisk.fades.find((f) => f.curve === curve && f.x === -1);
      const above = onDisk.fades.find((f) => f.curve === curve && f.x === 2);
      expect(below?.gain, curve).toBe(0);
      expect(above?.gain, curve).toBe(1);
    }
  });
});
