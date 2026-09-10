/**
 * Track-level spatial automation encoding. slotIndex -2, addresses 0/1/2.
 */
export const SPATIAL_SLOT_INDEX = -2;
export const SPATIAL_AZIMUTH_PARAM = 0;
export const SPATIAL_ELEVATION_PARAM = 1;
export const SPATIAL_DISTANCE_PARAM = 2;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function azDegToValue(az: number): number {
  return clamp(((((az % 360) + 360) % 360) * 127) / 360, 0, 127);
}
export function valueToAzDeg(v: number): number {
  return v * (360 / 127);
}
export function elDegToValue(el: number): number {
  return clamp(clamp(el, -90, 90) * (127 / 180) + 63.5, 0, 127);
}
export function valueToElDeg(v: number): number {
  return (v - 63.5) * (180 / 127);
}
export function distToValue(d: number): number {
  return clamp(((clamp(d, 0.5, 5) - 0.5) / 4.5) * 127, 0, 127);
}
export function valueToDist(v: number): number {
  return 0.5 + (v / 127) * 4.5;
}
