import { NAMED_POSITIONS, type NamedSpatialPosition } from './positions';

/**
 * ACN/SN3D first-order Ambisonics. Channel order W, Y, Z, X.
 * Frame: -z front, +x right, +y up.
 */
export interface FOAGains {
  w: number;
  y: number;
  z: number;
  x: number;
}

export const FOA_W = 1 / Math.SQRT2;

export function foaGainsFromSpherical(azDeg: number, elDeg: number): FOAGains {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return {
    w: FOA_W,
    y: Math.sin(az) * Math.cos(el),
    z: Math.sin(el),
    x: Math.cos(az) * Math.cos(el),
  };
}

/**
 * FOA gains straight from a direction vector, with no trigonometry.
 *
 * `foaGainsFromPoint` goes through `atan2` and back out through `sin`/`cos`.
 * Those cancel. Writing `r = |p|` and `rxz = hypot(x, z)`:
 *
 *   cos(el) = rxz / r        sin(el) = y / r
 *   sin(az) = x / rxz        cos(az) = -z / rxz
 *
 * so `Y = sin(az)cos(el) = x/r`, `Z = sin(el) = y/r`, and
 * `X = cos(az)cos(el) = -z/r`. The gains are just the normalized direction
 * with the axes relabelled, which is what ACN/SN3D first order means
 * geometrically.
 *
 * This matters because the real-time encoder runs it per sample with
 * audio-rate position params. Four trig calls per sample per voice is a cost
 * worth not paying for an identity.
 *
 * **The origin is omni here, and that is a deliberate difference.**
 * `foaGainsFromPoint({x: 0, y: 0, z: 0})` returns a front-facing direction,
 * because `Math.atan2(0, -0)` is `Math.PI`: an artifact of negative zero, not
 * a decision. Unreachable in the offline path, since a global source passes
 * `null` rather than the origin, but a position param sweeping through zero
 * reaches it every time, and a sign flip mid-sweep is an audible click. So a
 * source at the listener is omnidirectional, which is also the physically
 * sensible reading of "no direction to it".
 *
 * `foaGainsFromPoint` is left exactly as it was: it is checked against the
 * Swift and Kotlin implementations, and this function agrees with it
 * everywhere except that degenerate point.
 */
export function foaGainsFromDirection(x: number, y: number, z: number): FOAGains {
  const r = Math.hypot(x, y, z);
  if (!(r > 1e-9)) return { w: FOA_W, y: 0, z: 0, x: 0 };
  return { w: FOA_W, y: x / r, z: y / r, x: -z / r };
}

/** `null` is a global (omni) source: W only, rotation-immune. */
export function foaGainsFromPoint(point: { x: number; y: number; z: number } | null): FOAGains {
  if (!point) return { w: FOA_W, y: 0, z: 0, x: 0 };
  const az = Math.atan2(point.x, -point.z);
  const el = Math.atan2(point.y, Math.hypot(point.x, point.z));
  return {
    w: FOA_W,
    y: Math.sin(az) * Math.cos(el),
    z: Math.sin(el),
    x: Math.cos(az) * Math.cos(el),
  };
}

/**
 * Stereo AAC fallback:
 *   panL = max(0, 0.5 - Y * 0.5)
 *   panR = max(0, 0.5 + Y * 0.5)
 * recoverYFromRMS inverts this from L/R RMS.
 */
export function stereoPanFromY(y: number): { l: number; r: number } {
  return {
    l: Math.max(0, 0.5 - y * 0.5),
    r: Math.max(0, 0.5 + y * 0.5),
  };
}

export function recoverYFromRMS(lRMS: number, rRMS: number): number {
  const total = lRMS + rRMS;
  if (total < 1e-8) return 0;
  const ratio = rRMS / Math.max(1e-8, lRMS);
  return (ratio - 1) / (ratio + 1);
}

/**
 * Closest named position by FOA Y. Pairs that share a Y (front/rear, center/above)
 * prefer the front / center variant, matching SpatialAudioParser.NAMED_POSITION_Y.
 */
const NAMED_POSITION_Y: ReadonlyArray<readonly [NamedSpatialPosition, number]> = [
  ['side-left', -1],
  ['front-left', -0.7071],
  ['center', 0],
  ['front-right', 0.7071],
  ['side-right', 1],
];

export function closestNamedPositionByY(y: number): NamedSpatialPosition {
  let best: NamedSpatialPosition = 'center';
  let bestDist = Infinity;
  for (const [name, yRef] of NAMED_POSITION_Y) {
    const dist = Math.abs(y - yRef);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

export function namedPositionY(name: NamedSpatialPosition): number {
  const p = NAMED_POSITIONS[name];
  return foaGainsFromPoint(p).y;
}
