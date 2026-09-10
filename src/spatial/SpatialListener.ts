import { Vec3 } from './Vec3';

/**
 * Listener at the origin looking down -z, matching AVAudioEnvironmentNode
 * and THREE.AudioListener.
 */
export class SpatialListener {
  readonly position = new Vec3(0, 0, 0);
  readonly forward = new Vec3(0, 0, -1);
  readonly up = new Vec3(0, 1, 0);

  setOrientation(forward: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }): this {
    this.forward.copy(forward);
    this.up.copy(up);
    return this;
  }

  /**
   * Yaw/pitch in degrees. 0 yaw looks -z (front). Positive yaw turns right
   * (90° = +x).
   */
  setYawPitch(yawDeg: number, pitchDeg = 0): this {
    const yaw = (yawDeg * Math.PI) / 180;
    const pitch = (pitchDeg * Math.PI) / 180;
    const cp = Math.cos(pitch);
    this.forward.set(cp * Math.sin(yaw), Math.sin(pitch), -cp * Math.cos(yaw));
    this.up.set(0, 1, 0);
    return this;
  }
}
