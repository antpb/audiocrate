/**
 * The arithmetic behind `SpatialBus`, as pure functions.
 *
 * `SpatialBus` is a graph of `GainNode`s and `PannerNode`s, which means it can
 * only be exercised where an `AudioContext` exists. The parts of it that are
 * actually easy to get wrong are not the wiring but the numbers: a sign error
 * in the rotation, or an axis swapped between the encoder's channel order and
 * the decoder's, both produce audio that plays perfectly and comes out of the
 * wrong side of your head.
 *
 * So the numbers live here, where a Node test can check them against
 * `foa.ts` and `spherical.ts` directly, and `SpatialBus` becomes a thin
 * application of them. `scripts/check-spatial.mjs` then verifies in a real
 * browser that the graph is wired the way these say it should be.
 */
import type { FOAGains } from './foa';

/** A unit direction in the same frame as `positions.ts`: +x right, +y up, -z front. */
export type Direction = readonly [number, number, number];

/**
 * `SpatialBus`'s decode directions: a regular octahedron.
 *
 * Six rather than a cube's eight because four of these sit exactly in the
 * horizontal plane, where nearly everything in a mix lives. A cube puts none
 * there, spending its resolution on elevations music rarely uses.
 *
 * They sum to zero, which is what makes the decode gain-neutral.
 */
export const FOA_VIRTUAL_SPEAKERS: readonly Direction[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * The nine coefficients of the first-order rotation, keyed `<output><input>`.
 *
 * W is omitted because it is rotation-invariant, which is the same property
 * that makes a `global` source immune to head turns.
 */
export interface FoaRotation {
  yy: number;
  yz: number;
  yx: number;
  zy: number;
  zz: number;
  zx: number;
  xy: number;
  xz: number;
  xx: number;
}

/**
 * Rotates the field to a listener facing `yawDeg` / `pitchDeg`.
 *
 * Yaw 0 looks down `-z`, positive yaw turns right, positive pitch looks up,
 * matching `SpatialListener.setYawPitch`.
 *
 * ## Where these come from
 *
 * The ACN channels are the direction vector relabelled: `Y = dx`, `Z = dy`,
 * `X = -dz` (see `foaGainsFromDirection`). Turning the listener right by `p`
 * is turning the field left by `p`, so a source's direction in the listener's
 * frame is `R_y(p) d`:
 *
 *   dx' = dx cos p + dz sin p
 *   dz' = -dx sin p + dz cos p
 *
 * Substituting the channel labels gives the yaw rows below. Pitch then
 * rotates the resulting front-back against up-down. Positive pitch looks up,
 * so a source that was ahead moves down, which is why `zx` carries the minus.
 */
export function foaRotationMatrix(yawDeg: number, pitchDeg = 0): FoaRotation {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    yy: cy,
    yz: 0,
    yx: -sy,
    zy: -sp * sy,
    zz: cp,
    zx: -sp * cy,
    xy: cp * sy,
    xz: sp,
    xx: cp * cy,
  };
}

/** Applies a rotation to a set of gains. W passes through untouched. */
export function rotateFoaGains(gains: FOAGains, rotation: FoaRotation): FOAGains {
  return {
    w: gains.w,
    y: rotation.yy * gains.y + rotation.yz * gains.z + rotation.yx * gains.x,
    z: rotation.zy * gains.y + rotation.zz * gains.z + rotation.zx * gains.x,
    x: rotation.xy * gains.y + rotation.xz * gains.z + rotation.xx * gains.x,
  };
}

/**
 * How much of each B-format channel one virtual speaker takes.
 *
 * The basic (projection) decoder. For a speaker pointing `u`, one of `count`
 * in a layout that sums to zero, a source at direction `d` arrives with
 * weight `(1 + d.u) / count`: unity when the speaker faces it, silent when
 * the speaker faces away, and a cardioid in between. That width is inherent
 * to first order, not a shortcut.
 */
export function foaSpeakerWeights(direction: Direction, count: number): FOAGains {
  const [ux, uy, uz] = direction;
  return {
    w: Math.SQRT2 / count,
    y: ux / count,
    z: uy / count,
    x: -uz / count,
  };
}

/** The signal one virtual speaker receives from a field. */
export function decodeFoaToSpeaker(gains: FOAGains, direction: Direction, count: number): number {
  const k = foaSpeakerWeights(direction, count);
  return gains.w * k.w + gains.y * k.y + gains.z * k.z + gains.x * k.x;
}

/**
 * The two-speaker stereo decode: virtual cardioids hard left and hard right.
 *
 * This works out to exactly the pan law in `stereoPanFromY` that the DAW uses
 * for its AAC fallback track, minus that function's clamp at zero. Keeping
 * them equal means the cheap monitor path and the cheap export path agree,
 * and the test asserts it rather than leaving it as a comment.
 */
export function decodeFoaToStereo(gains: FOAGains): { l: number; r: number } {
  const mid = gains.w * Math.SQRT2 * 0.5;
  return { l: mid - gains.y * 0.5, r: mid + gains.y * 0.5 };
}
