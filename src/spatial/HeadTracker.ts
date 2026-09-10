/**
 * Turns the listener from whatever the browser will tell you about a head.
 *
 * ## What is actually available, and what is not
 *
 * **AirPods head tracking is not reachable from a web page.** On Apple
 * platforms it is a system feature: a native app sets
 * `AVAudioEnvironmentNode.isListenerHeadTrackingEnabled` and the OS folds the
 * headphone motion in for you. Nothing exposes that to JavaScript. Probing
 * Safari 26 on macOS for every plausible spelling of a headphone-motion API
 * returns nothing, and WebXR is absent there too.
 *
 * So this offers the sources that do exist:
 *
 * | Source | Where it works | What you turn |
 * | --- | --- | --- |
 * | `deviceorientation` | Phones and tablets | The device |
 * | `pointer` | Anywhere with a mouse or trackpad | Drag to look |
 *
 * Neither is a head. A phone held at arm's length and turned with you is a
 * decent approximation and needs no code from the listener; a pointer drag is
 * the practical desktop test.
 *
 * ## The system spatializer will fight you
 *
 * If macOS or iOS has "Spatialize Stereo" active for the output device, it
 * applies its own head-tracked room to *any* stereo the browser produces,
 * including audio this library has already spatialized. The result is two
 * rooms stacked on top of each other and localization that goes soft. Turn it
 * off in Control Center before judging anything.
 *
 * ## Honesty about verification
 *
 * `poseFromDeviceOrientation` is derived from the W3C definitions of `alpha`
 * and `beta` and is unit tested against them. It has not been checked on a
 * physical phone in this repo. If the yaw comes out mirrored on a device,
 * `invertYaw` is the switch, and the mapping being one pure function is what
 * makes that a one-line fix rather than an investigation.
 */

export type HeadTrackerSource = 'deviceorientation' | 'pointer';

/** Yaw and pitch in degrees, in `SpatialBus.setYawPitch`'s convention. */
export interface HeadPose {
  yawDeg: number;
  pitchDeg: number;
}

/** The device angles this reads. A subset of `DeviceOrientationEvent`. */
export interface DeviceAngles {
  alpha: number | null;
  beta: number | null;
}

/** Where the listener was facing when `recenter` was last called. */
export interface PoseReference {
  alpha: number;
  beta: number;
}

/** Wraps to (-180, 180], so turning past north is a small step, not a full circle. */
export function wrapDegrees(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  // `-180` and `180` are the same angle; pick the positive one so the result
  // is stable rather than flipping sign on either side of the boundary.
  return wrapped === -180 ? 180 : wrapped;
}

function clamp(value: number, lo: number, hi: number): number {
  const clamped = Math.min(hi, Math.max(lo, value));
  // `-0` compares equal to `0` but serializes and prints differently, and a
  // pose at rest reading `-0` is the sort of thing that turns into a
  // confusing diff later.
  return clamped === 0 ? 0 : clamped;
}

/**
 * Device angles to a listener pose, relative to where `recenter` was called.
 *
 * `alpha` is the compass rotation and **increases counter-clockwise** seen
 * from above, so turning the device to the right makes it fall. Yaw is
 * positive to the right, which is why this subtracts rather than adds.
 *
 * `beta` is the front-back tilt, 0 flat and 90 upright. Taking it relative to
 * the reference is what lets someone hold the phone at whatever angle is
 * comfortable instead of at a prescribed one.
 */
export function poseFromDeviceOrientation(
  angles: DeviceAngles,
  reference: PoseReference,
  options: { invertYaw?: boolean } = {},
): HeadPose {
  const alpha = angles.alpha ?? reference.alpha;
  const beta = angles.beta ?? reference.beta;
  const yaw = wrapDegrees(reference.alpha - alpha);
  return {
    yawDeg: options.invertYaw ? -yaw : yaw,
    // Clamped, not wrapped. Yaw is a compass and wraps; pitch is a tilt and
    // does not. Wrapping it means a device tipped a full half turn from the
    // reference comes back as "looking straight up" when it went the other
    // way, because 180 and -180 are the same angle to a wrap and opposite
    // poles to a listener.
    pitchDeg: clamp(beta - reference.beta, -90, 90),
  };
}

/** Pointer travel in pixels to a listener pose. */
export function poseFromDrag(
  dx: number,
  dy: number,
  degreesPerPixel = 0.4,
): HeadPose {
  return {
    yawDeg: wrapDegrees(dx * degreesPerPixel),
    // Dragging down looks down, which is the direction every camera control
    // in every 3D tool agrees on.
    pitchDeg: clamp(-dy * degreesPerPixel, -90, 90),
  };
}

export interface HeadTrackerOptions {
  /** Called with each new pose. Wire it to `bus.setYawPitch`. */
  onPose: (pose: HeadPose) => void;
  /** Element that receives pointer drags. Defaults to the document body. */
  target?: EventTarget;
  degreesPerPixel?: number;
  /** Flip yaw if a device turns the field the wrong way. */
  invertYaw?: boolean;
}

/**
 * Which sources this browser can offer, best first.
 *
 * `deviceorientation` is reported when the event type exists, which is not a
 * promise that a sensor will ever fire: a desktop Safari has the constructor
 * and no hardware behind it. `start` resolves that by waiting for a real
 * event and falling back rather than leaving the listener stuck facing front.
 */
export function availableHeadTrackerSources(): HeadTrackerSource[] {
  const sources: HeadTrackerSource[] = [];
  if (typeof DeviceOrientationEvent !== 'undefined') sources.push('deviceorientation');
  if (typeof window !== 'undefined') sources.push('pointer');
  return sources;
}

export class HeadTracker {
  private readonly options: HeadTrackerOptions;
  private reference: PoseReference = { alpha: 0, beta: 90 };
  private active: HeadTrackerSource | null = null;
  private detach: (() => void) | null = null;
  private latest: DeviceAngles = { alpha: null, beta: null };
  /** Accumulated drag, so a pointer look survives letting go and grabbing again. */
  private dragX = 0;
  private dragY = 0;

  constructor(options: HeadTrackerOptions) {
    this.options = options;
  }

  get source(): HeadTrackerSource | null {
    return this.active;
  }

  /**
   * Starts tracking, resolving to the source that actually worked.
   *
   * With `deviceorientation` it waits briefly for a real event before
   * committing, because the event type existing says nothing about a sensor
   * being attached. Rejecting instead of falling back would leave a desktop
   * user with a button that does nothing and no explanation.
   */
  async start(preferred?: HeadTrackerSource): Promise<HeadTrackerSource | null> {
    this.stop();
    const order: HeadTrackerSource[] = preferred
      ? [preferred, ...availableHeadTrackerSources().filter((s) => s !== preferred)]
      : availableHeadTrackerSources();
    for (const source of order) {
      if (source === 'deviceorientation' && (await this.startOrientation())) return this.active;
      if (source === 'pointer' && this.startPointer()) return this.active;
    }
    return null;
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
    this.active = null;
  }

  /** Treats the current attitude as facing front. */
  recenter(): void {
    if (this.active === 'pointer') {
      this.dragX = 0;
      this.dragY = 0;
    } else {
      this.reference = {
        alpha: this.latest.alpha ?? this.reference.alpha,
        beta: this.latest.beta ?? this.reference.beta,
      };
    }
    this.options.onPose({ yawDeg: 0, pitchDeg: 0 });
  }

  private async startOrientation(): Promise<boolean> {
    if (typeof DeviceOrientationEvent === 'undefined' || typeof window === 'undefined') return false;
    // iOS gates the sensor behind a prompt that only a user gesture may
    // raise. A rejection here is a decline, not an error.
    const request = (DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    }).requestPermission;
    if (typeof request === 'function') {
      try {
        if ((await request()) !== 'granted') return false;
      } catch {
        return false;
      }
    }

    let fired = false;
    const onOrientation = (event: Event): void => {
      const angles = event as DeviceOrientationEvent;
      if (angles.alpha === null && angles.beta === null) return;
      if (!fired) {
        fired = true;
        this.reference = { alpha: angles.alpha ?? 0, beta: angles.beta ?? 90 };
      }
      this.latest = { alpha: angles.alpha, beta: angles.beta };
      this.options.onPose(
        poseFromDeviceOrientation(this.latest, this.reference, { invertYaw: this.options.invertYaw }),
      );
    };
    window.addEventListener('deviceorientation', onOrientation);

    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!fired) {
      window.removeEventListener('deviceorientation', onOrientation);
      return false;
    }
    this.active = 'deviceorientation';
    this.detach = () => window.removeEventListener('deviceorientation', onOrientation);
    return true;
  }

  private startPointer(): boolean {
    const target = this.options.target ?? (typeof document !== 'undefined' ? document.body : null);
    if (!target) return false;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const down = (event: Event): void => {
      const pointer = event as PointerEvent;
      dragging = true;
      lastX = pointer.clientX;
      lastY = pointer.clientY;
    };
    const move = (event: Event): void => {
      if (!dragging) return;
      const pointer = event as PointerEvent;
      this.dragX += pointer.clientX - lastX;
      this.dragY += pointer.clientY - lastY;
      lastX = pointer.clientX;
      lastY = pointer.clientY;
      this.options.onPose(poseFromDrag(this.dragX, this.dragY, this.options.degreesPerPixel));
    };
    const up = (): void => {
      dragging = false;
    };

    target.addEventListener('pointerdown', down);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    this.active = 'pointer';
    this.detach = () => {
      target.removeEventListener('pointerdown', down);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    return true;
  }
}
