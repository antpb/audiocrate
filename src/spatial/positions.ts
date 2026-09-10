import { Vec3 } from './Vec3';

/**
 * Named spatial presets.
 *
 * Frame: +x right, +y up, -z front.
 */
export const NAMED_POSITIONS = {
  center: { x: 0.0, y: 0.0, z: -1.0 },
  'front-left': { x: -0.7, y: 0.0, z: -0.7 },
  'front-right': { x: 0.7, y: 0.0, z: -0.7 },
  'side-left': { x: -1.0, y: 0.0, z: 0.0 },
  'side-right': { x: 1.0, y: 0.0, z: 0.0 },
  'rear-left': { x: -0.7, y: 0.0, z: 0.7 },
  'rear-right': { x: 0.7, y: 0.0, z: 0.7 },
  above: { x: 0.0, y: 1.0, z: -0.3 },
} as const;

export type NamedSpatialPosition = keyof typeof NAMED_POSITIONS;
export type SpatialPositionName = NamedSpatialPosition | 'global';

export const SPATIAL_POSITION_NAMES = [
  'global',
  'center',
  'front-left',
  'front-right',
  'side-left',
  'side-right',
  'rear-left',
  'rear-right',
  'above',
] as const satisfies readonly SpatialPositionName[];

export function namedPositionVec(name: NamedSpatialPosition): Vec3 {
  const p = NAMED_POSITIONS[name];
  return new Vec3(p.x, p.y, p.z);
}

export function isNamedSpatialPosition(name: string): name is NamedSpatialPosition {
  return Object.prototype.hasOwnProperty.call(NAMED_POSITIONS, name);
}
