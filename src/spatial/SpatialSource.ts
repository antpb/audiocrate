import type { AutomationLane } from '../automation/AutomationLane';
import type { TimeContext } from '../Time';
import type { Clip } from '../graph/Clip';
import { NAMED_POSITIONS, isNamedSpatialPosition, type SpatialPositionName } from './positions';
import { cartesianToSpherical, sphericalToCartesian, type SphericalPos } from './spherical';
import { foaGainsFromPoint, type FOAGains } from './foa';
import { Vec3 } from './Vec3';

export type SpatialSourceTarget = 'position' | 'azimuth' | 'elevation' | 'distance';

export interface SpatialSourceOptions {
  clip?: Clip;
  named?: SpatialPositionName;
  volume?: number;
  trackIndex?: number;
}

/**
 * A point source (or `global`, which bypasses HRTF) plus optional clip.
 * `automate('azimuth'|'elevation'|'distance')` writes those axes.
 * `automate('position', lane)` is an azimuth orbit.
 */
export class SpatialSource {
  readonly position = new Vec3();
  named: SpatialPositionName | null;
  volume: number;
  trackIndex: number;
  readonly clip: Clip | null;
  private readonly automation: Array<{ target: SpatialSourceTarget; lane: AutomationLane }> = [];

  constructor(clipOrOptions?: Clip | SpatialSourceOptions, options?: SpatialSourceOptions) {
    const opts: SpatialSourceOptions =
      clipOrOptions && 'buffer' in clipOrOptions
        ? { ...(options ?? {}), clip: clipOrOptions }
        : ((clipOrOptions as SpatialSourceOptions | undefined) ?? {});
    this.clip = opts.clip ?? null;
    this.volume = opts.volume ?? 1;
    this.trackIndex = opts.trackIndex ?? 0;
    this.named = opts.named ?? 'center';
    if (this.named === 'global') {
      this.position.set(0, 0, 0);
    } else if (isNamedSpatialPosition(this.named)) {
      this.position.copy(NAMED_POSITIONS[this.named]);
    }
  }

  get isGlobal(): boolean {
    return this.named === 'global';
  }

  setNamed(name: SpatialPositionName): this {
    this.named = name;
    if (name === 'global') this.position.set(0, 0, 0);
    else this.position.copy(NAMED_POSITIONS[name]);
    return this;
  }

  spherical(): SphericalPos | null {
    if (this.isGlobal) return null;
    return cartesianToSpherical(this.position);
  }

  foaGains(): FOAGains {
    return foaGainsFromPoint(this.isGlobal ? null : this.position);
  }

  automate(target: SpatialSourceTarget, lane: AutomationLane): void {
    this.automation.push({ target, lane });
  }

  get automationLanes(): readonly { target: SpatialSourceTarget; lane: AutomationLane }[] {
    return this.automation;
  }

  /**
   * Apply azimuth/elevation/distance lanes at `timelineSec`. Missing axes
   * keep the current cartesian position. Global sources stay global.
   */
  evaluateAt(timelineSec: number, ctx: TimeContext): Vec3 | null {
    if (this.isGlobal) return null;
    const current = cartesianToSpherical(this.position);
    let az = current.azDeg;
    let el = current.elDeg;
    let dist = current.distance;
    for (const { target, lane } of this.automation) {
      const value = lane.evaluate(timelineSec, ctx);
      if (value === undefined) continue;
      if (target === 'azimuth' || target === 'position') az = value;
      else if (target === 'elevation') el = value;
      else dist = value;
    }
    return sphericalToCartesian(az, el, dist);
  }
}
