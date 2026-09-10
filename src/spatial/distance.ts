/**
 * Inverse-distance models.
 * Preview: ref 1, max 4, roll 1.
 * Web HRTF: ref 1.5, max 100, roll 1.
 */
export const DISTANCE_MODELS = {
  preview: { refDistance: 1, maxDistance: 4, rolloffFactor: 1 },
  webHrtf: { refDistance: 1.5, maxDistance: 100, rolloffFactor: 1 },
} as const;

export interface DistanceModel {
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
}

export function distanceAttenuation(distance: number, model: DistanceModel = DISTANCE_MODELS.preview): number {
  const clamped = Math.max(model.refDistance, Math.min(model.maxDistance, distance));
  return model.refDistance / (model.refDistance + model.rolloffFactor * (clamped - model.refDistance));
}

/**
 * Far sources tick automation less often.
 */
export function spatialUpdateHz(distance: number): number {
  if (distance < 4) return 60;
  if (distance < 16) return 15;
  return 5;
}
