import { Vec3 } from './Vec3';

export interface SphericalPos {
  azDeg: number;
  elDeg: number;
  distance: number;
}

/**
 * 0° azimuth = front (-z), 90° = right (+x), 180° = rear (+z), 270° = left (-x).
 * +elevation raises the source (+y).
 */
export function sphericalToCartesian(azDeg: number, elDeg: number, distance: number): Vec3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const r = Math.max(0.0001, distance);
  const xz = r * Math.cos(el);
  return new Vec3(xz * Math.sin(az), r * Math.sin(el), -xz * Math.cos(az));
}

/** Inverse of sphericalToCartesian. Azimuth wrapped to 0..360. */
export function cartesianToSpherical(p: { x: number; y: number; z: number }): SphericalPos {
  const dist = Math.hypot(p.x, p.y, p.z);
  const safe = dist === 0 ? 0.0001 : dist;
  let azDeg = (Math.atan2(p.x, -p.z) * 180) / Math.PI;
  if (azDeg < 0) azDeg += 360;
  const elDeg = (Math.asin(p.y / safe) * 180) / Math.PI;
  return { azDeg, elDeg, distance: dist };
}
