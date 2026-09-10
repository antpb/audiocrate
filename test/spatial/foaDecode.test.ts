/**
 * Rotation and decode, checked against the encode rather than against
 * themselves.
 *
 * A decoder can be internally consistent and still wrong. These tests all
 * start from `foaGainsFromPoint` or `sphericalToCartesian`, the functions the
 * DAW's Swift and the Android Kotlin are already checked against, so an axis
 * swapped between encode and decode has nowhere to hide.
 */
import { describe, expect, it } from 'vitest';
import {
  FOA_VIRTUAL_SPEAKERS,
  decodeFoaToSpeaker,
  decodeFoaToStereo,
  foaRotationMatrix,
  foaSpeakerWeights,
  rotateFoaGains,
  type Direction,
} from '../../src/spatial/decode';
import { FOA_W, foaGainsFromDirection, foaGainsFromPoint, stereoPanFromY } from '../../src/spatial/foa';
import { NAMED_POSITIONS, type NamedSpatialPosition } from '../../src/spatial/positions';
import { sphericalToCartesian } from '../../src/spatial/spherical';

const loudest = (gains: ReturnType<typeof foaGainsFromDirection>): Direction => {
  let best = FOA_VIRTUAL_SPEAKERS[0]!;
  let bestValue = -Infinity;
  for (const speaker of FOA_VIRTUAL_SPEAKERS) {
    const value = decodeFoaToSpeaker(gains, speaker, FOA_VIRTUAL_SPEAKERS.length);
    if (value > bestValue) {
      bestValue = value;
      best = speaker;
    }
  }
  return best;
};

describe('foaGainsFromDirection matches the reference it replaces', () => {
  const names = Object.keys(NAMED_POSITIONS) as NamedSpatialPosition[];

  it.each(names)('agrees with foaGainsFromPoint at "%s"', (name) => {
    const p = NAMED_POSITIONS[name];
    const reference = foaGainsFromPoint(p);
    const direct = foaGainsFromDirection(p.x, p.y, p.z);
    expect(direct.w).toBeCloseTo(reference.w, 12);
    expect(direct.y).toBeCloseTo(reference.y, 12);
    expect(direct.z).toBeCloseTo(reference.z, 12);
    expect(direct.x).toBeCloseTo(reference.x, 12);
  });

  it('agrees across a sweep of azimuths and elevations', () => {
    for (let az = 0; az < 360; az += 7) {
      for (const el of [-80, -35, 0, 20, 60]) {
        const p = sphericalToCartesian(az, el, 1 + (az % 3));
        const reference = foaGainsFromPoint(p);
        const direct = foaGainsFromDirection(p.x, p.y, p.z);
        expect(direct.y).toBeCloseTo(reference.y, 12);
        expect(direct.z).toBeCloseTo(reference.z, 12);
        expect(direct.x).toBeCloseTo(reference.x, 12);
      }
    }
  });

  it('is scale invariant, because direction is all it encodes', () => {
    const near = foaGainsFromDirection(0.3, 0, -0.3);
    const far = foaGainsFromDirection(30, 0, -30);
    expect(near.x).toBeCloseTo(far.x, 12);
    expect(near.y).toBeCloseTo(far.y, 12);
  });
});

describe('the virtual speaker layout', () => {
  it('sums to zero, which is what makes the decode gain neutral', () => {
    const sum = FOA_VIRTUAL_SPEAKERS.reduce(
      (acc, [x, y, z]) => [acc[0] + x, acc[1] + y, acc[2] + z] as [number, number, number],
      [0, 0, 0] as [number, number, number],
    );
    expect(sum[0]).toBeCloseTo(0, 12);
    expect(sum[1]).toBeCloseTo(0, 12);
    expect(sum[2]).toBeCloseTo(0, 12);
  });

  it('reconstructs unit gain however the source is pointed', () => {
    for (let az = 0; az < 360; az += 11) {
      const p = sphericalToCartesian(az, 17, 1);
      const gains = foaGainsFromDirection(p.x, p.y, p.z);
      const total = FOA_VIRTUAL_SPEAKERS.reduce(
        (sum, speaker) => sum + decodeFoaToSpeaker(gains, speaker, FOA_VIRTUAL_SPEAKERS.length),
        0,
      );
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it('sends a source to the speaker facing it and nothing to the one behind', () => {
    const right = foaGainsFromDirection(1, 0, 0);
    expect(decodeFoaToSpeaker(right, [1, 0, 0], 6)).toBeCloseTo(2 / 6, 12);
    expect(decodeFoaToSpeaker(right, [-1, 0, 0], 6)).toBeCloseTo(0, 12);
  });
});

describe('a source decodes loudest at the speaker nearest it', () => {
  const cases: Array<[string, Direction]> = [
    ['right', [1, 0, 0]],
    ['left', [-1, 0, 0]],
    ['front', [0, 0, -1]],
    ['rear', [0, 0, 1]],
    ['above', [0, 1, 0]],
    ['below', [0, -1, 0]],
  ];

  it.each(cases)('%s', (_label, direction) => {
    const gains = foaGainsFromDirection(...(direction as [number, number, number]));
    expect(loudest(gains)).toEqual(direction);
  });

  it('holds for the named DAW positions too', () => {
    // front-left is (-0.7, 0, -0.7): equidistant from the front and left
    // speakers, so assert the winner is one of them rather than a specific one.
    const gains = foaGainsFromDirection(-0.7, 0, -0.7);
    const winner = loudest(gains);
    expect([[-1, 0, 0], [0, 0, -1]]).toContainEqual(winner);
  });
});

describe('rotation', () => {
  it('is the identity at zero', () => {
    const r = foaRotationMatrix(0, 0);
    expect(r).toEqual({ yy: 1, yz: 0, yx: -0, zy: -0, zz: 1, zx: -0, xy: 0, xz: 0, xx: 1 });
  });

  it('turning the listener right by 90 puts a source on the right in front', () => {
    // The property that matters for head tracking: the listener turns toward
    // the source, so the source ends up ahead of them.
    const source = foaGainsFromDirection(1, 0, 0);
    const rotated = rotateFoaGains(source, foaRotationMatrix(90));
    const ahead = foaGainsFromDirection(0, 0, -1);
    expect(rotated.y).toBeCloseTo(ahead.y, 12);
    expect(rotated.x).toBeCloseTo(ahead.x, 12);
    expect(rotated.z).toBeCloseTo(ahead.z, 12);
  });

  it('a rotation of yaw equals encoding at an azimuth lower by yaw', () => {
    for (const yaw of [0, 30, 90, 145, 270]) {
      for (const az of [0, 45, 120, 300]) {
        const p = sphericalToCartesian(az, 0, 1);
        const rotated = rotateFoaGains(foaGainsFromDirection(p.x, p.y, p.z), foaRotationMatrix(yaw));
        const q = sphericalToCartesian(az - yaw, 0, 1);
        const direct = foaGainsFromDirection(q.x, q.y, q.z);
        expect(rotated.y).toBeCloseTo(direct.y, 10);
        expect(rotated.x).toBeCloseTo(direct.x, 10);
      }
    }
  });

  it('positive pitch looks up, so a source ahead moves below the listener', () => {
    const ahead = foaGainsFromDirection(0, 0, -1);
    const rotated = rotateFoaGains(ahead, foaRotationMatrix(0, 30));
    expect(rotated.z).toBeLessThan(0);
    expect(rotated.x).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 10);
  });

  it('preserves energy', () => {
    for (const [yaw, pitch] of [[37, 0], [0, 55], [120, -20], [300, 80]]) {
      const p = sphericalToCartesian(63, 12, 1);
      const gains = foaGainsFromDirection(p.x, p.y, p.z);
      const rotated = rotateFoaGains(gains, foaRotationMatrix(yaw!, pitch!));
      const before = Math.hypot(gains.y, gains.z, gains.x);
      const after = Math.hypot(rotated.y, rotated.z, rotated.x);
      expect(after).toBeCloseTo(before, 10);
    }
  });

  it('leaves a global source alone at every orientation', () => {
    // Global is W only. The DAW gets this by skipping its environment node
    // entirely; here it is emergent, so it needs asserting.
    const global = { w: FOA_W, y: 0, z: 0, x: 0 };
    for (let yaw = 0; yaw < 360; yaw += 15) {
      const rotated = rotateFoaGains(global, foaRotationMatrix(yaw, yaw / 4));
      expect(rotated.w).toBe(FOA_W);
      expect(rotated.y).toBeCloseTo(0, 12);
      expect(rotated.z).toBeCloseTo(0, 12);
      expect(rotated.x).toBeCloseTo(0, 12);
    }
  });
});

describe('the stereo decode is the DAW fallback pan law', () => {
  it('matches stereoPanFromY wherever that function does not clamp', () => {
    // The AAC fallback track in an APAC export is built with stereoPanFromY.
    // If the browser's cheap monitor path used a different law, a mix judged
    // in stereo here would not be the mix that shipped.
    for (let az = 0; az < 360; az += 5) {
      const p = sphericalToCartesian(az, 0, 1);
      const gains = foaGainsFromDirection(p.x, p.y, p.z);
      const decoded = decodeFoaToStereo(gains);
      const reference = stereoPanFromY(gains.y);
      if (reference.l > 0) expect(decoded.l).toBeCloseTo(reference.l, 12);
      if (reference.r > 0) expect(decoded.r).toBeCloseTo(reference.r, 12);
    }
  });

  it('puts a hard right source entirely in the right channel', () => {
    const decoded = decodeFoaToStereo(foaGainsFromDirection(1, 0, 0));
    expect(decoded.r).toBeCloseTo(1, 12);
    expect(decoded.l).toBeCloseTo(0, 12);
  });

  it('centres a global source', () => {
    const decoded = decodeFoaToStereo({ w: FOA_W, y: 0, z: 0, x: 0 });
    expect(decoded.l).toBeCloseTo(0.5, 12);
    expect(decoded.r).toBeCloseTo(0.5, 12);
  });
});

describe('foaSpeakerWeights', () => {
  it('scales by the speaker count so a layout stays gain neutral', () => {
    const six = foaSpeakerWeights([1, 0, 0], 6);
    const two = foaSpeakerWeights([1, 0, 0], 2);
    expect(two.y).toBeCloseTo(six.y * 3, 12);
  });
});
