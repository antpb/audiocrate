/**
 * Sums first-order ambisonic sources, rotates the field to the listener, and
 * decodes it to something a pair of ears can use.
 *
 * ## What this is for
 *
 * `crate-foa-encoder` turns each source into four channels that carry its
 * direction. Adding two of those is adding four channels, so this class needs
 * no registry of connected sources and no side channel to learn where they
 * are: `bus.input` is an ordinary summing node that happens to be four wide.
 *
 * Everything downstream is then paid for once rather than per source. One
 * rotation serves any number of sources, and so does one decode.
 *
 * ## Why the decode is virtual loudspeakers
 *
 * Binaural output needs head-related transfer functions, and a library has
 * two ways to get them: ship a set of impulse responses, or use the ones the
 * browser already has inside `PannerNode`.
 *
 * Shipping them means several hundred kilobytes of measured data, a licence
 * to honour, and a package that no longer has zero runtime dependencies.
 * So instead the field is decoded to a small ring of fixed virtual speaker
 * directions, and each of those is played through a `PannerNode` pinned at
 * that direction with `panningModel: 'HRTF'`.
 *
 * The cost is fixed: six panners, whether one source is connected or forty.
 * The quality is whatever the browser's HRTF is, which is not Apple's, so a
 * mix judged here will not translate to AirPods sample for sample. That is a
 * real limitation and the reason `toAmbisonics` and the stereo fallback both
 * remain first-class outputs rather than debug conveniences.
 *
 * ## Rotation is control rate, deliberately
 *
 * The nine matrix coefficients are `AudioParam`s, but yaw and pitch are not:
 * turning an angle into those coefficients goes through `sin` and `cos`, so
 * an audio-rate yaw would need its own worklet the way position does.
 *
 * Head rotation does not need it. A head turns at human speed and every
 * spatial audio engine updates its listener once per frame; `setYawPitch`
 * ramps rather than steps, so a 60 Hz pose feed produces no zipper. Position
 * is the case that genuinely needed audio rate, because an LFO on an axis is
 * a musical gesture rather than a physical one.
 */
import {
  FOA_VIRTUAL_SPEAKERS,
  foaRotationMatrix,
  foaSpeakerWeights,
  type Direction,
} from './decode';

export type SpatialDecodeMode = 'binaural' | 'stereo' | 'ambisonic';

export interface SpatialBusOptions {
  /** Defaults to `binaural`. */
  decode?: SpatialDecodeMode;
  /** Seconds for `setYawPitch` to reach a new orientation. Defaults to 0.02. */
  rotationSmoothing?: number;
}

export class SpatialBus {
  /** Connect spatial sources here. Four channels, summed discretely. */
  readonly input: GainNode;
  /** Connect this onward: stereo for `binaural` and `stereo`, four for `ambisonic`. */
  readonly output: GainNode;

  private readonly context: BaseAudioContext;
  private readonly smoothing: number;
  /** Rotated B-format, as four summing points rather than a merged stream. */
  private readonly rot: { w: GainNode; y: GainNode; z: GainNode; x: GainNode };
  /** Nine rotation coefficients, keyed `outputInput`, e.g. `yx` is X's share of Y. */
  private readonly matrix: Record<string, GainNode> = {};
  private readonly panners: PannerNode[] = [];
  private decodeMode: SpatialDecodeMode;
  private yawDeg = 0;
  private pitchDeg = 0;

  constructor(context: BaseAudioContext, options: SpatialBusOptions = {}) {
    this.context = context;
    this.decodeMode = options.decode ?? 'binaural';
    this.smoothing = Math.max(0, options.rotationSmoothing ?? 0.02);

    this.input = context.createGain();
    this.input.channelCount = 4;
    this.input.channelCountMode = 'explicit';
    // Discrete, not `speakers`. The default interpretation would treat four
    // channels as a surround layout and helpfully downmix them, which for
    // B-format means silently destroying the field before it is decoded.
    this.input.channelInterpretation = 'discrete';

    this.output = context.createGain();

    const splitter = context.createChannelSplitter(4);
    this.input.connect(splitter);

    const sum = (): GainNode => {
      const node = context.createGain();
      node.gain.value = 1;
      return node;
    };
    this.rot = { w: sum(), y: sum(), z: sum(), x: sum() };

    // W is rotation-invariant: it is the omnidirectional component, which is
    // also why a `global` source is immune to head turns for free.
    splitter.connect(this.rot.w, 0);

    // Channel order is ACN: 0 W, 1 Y, 2 Z, 3 X.
    const inputChannel: Record<string, number> = { y: 1, z: 2, x: 3 };
    for (const out of ['y', 'z', 'x'] as const) {
      for (const inp of ['y', 'z', 'x'] as const) {
        const coefficient = context.createGain();
        coefficient.gain.value = out === inp ? 1 : 0;
        splitter.connect(coefficient, inputChannel[inp]!);
        coefficient.connect(this.rot[out]);
        this.matrix[`${out}${inp}`] = coefficient;
      }
    }

    this.buildDecode();
  }

  /** Which decode is currently wired. */
  get decode(): SpatialDecodeMode {
    return this.decodeMode;
  }

  /**
   * Swaps the decode. Rebuilds only the stage after the rotation, so
   * connected sources stay connected and no audio is interrupted upstream.
   */
  setDecode(mode: SpatialDecodeMode): void {
    if (mode === this.decodeMode) return;
    this.decodeMode = mode;
    this.buildDecode();
  }

  /**
   * Points the listener. Yaw 0 looks down `-z`; positive yaw turns right,
   * positive pitch looks up, matching `SpatialListener.setYawPitch`.
   */
  setYawPitch(yawDeg: number, pitchDeg = 0): void {
    this.yawDeg = yawDeg;
    this.pitchDeg = pitchDeg;
    const rotation = foaRotationMatrix(yawDeg, pitchDeg);
    for (const [key, value] of Object.entries(rotation)) this.setCoefficient(key, value);
  }

  /** The orientation last requested, in degrees. */
  get orientation(): { yawDeg: number; pitchDeg: number } {
    return { yawDeg: this.yawDeg, pitchDeg: this.pitchDeg };
  }

  /** Releases the decode stage. The input and rotation stay usable. */
  dispose(): void {
    this.teardownDecode();
    try {
      this.rot.w.disconnect();
      this.rot.y.disconnect();
      this.rot.z.disconnect();
      this.rot.x.disconnect();
    } catch {
      /* already gone */
    }
  }

  private setCoefficient(key: string, value: number): void {
    const node = this.matrix[key];
    if (!node) return;
    const now = this.context.currentTime;
    if (this.smoothing > 0) {
      // `setTargetAtTime` rather than a ramp: a pose feed posts a new
      // orientation before the previous one has landed, and cancelling a
      // ramp every frame is what produces the stepping this avoids.
      node.gain.setTargetAtTime(value, now, this.smoothing / 3);
    } else {
      node.gain.value = value;
    }
  }

  private teardownDecode(): void {
    for (const panner of this.panners) {
      try {
        panner.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.panners.length = 0;
    for (const node of [this.rot.w, this.rot.y, this.rot.z, this.rot.x]) {
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    }
  }

  private buildDecode(): void {
    this.teardownDecode();
    const ctx = this.context;

    if (this.decodeMode === 'ambisonic') {
      const merger = ctx.createChannelMerger(4);
      this.rot.w.connect(merger, 0, 0);
      this.rot.y.connect(merger, 0, 1);
      this.rot.z.connect(merger, 0, 2);
      this.rot.x.connect(merger, 0, 3);
      this.output.channelCount = 4;
      this.output.channelCountMode = 'explicit';
      this.output.channelInterpretation = 'discrete';
      merger.connect(this.output);
      return;
    }

    this.output.channelCount = 2;
    this.output.channelCountMode = 'explicit';
    this.output.channelInterpretation = 'speakers';

    if (this.decodeMode === 'stereo') {
      // Two virtual speakers at hard left and hard right, which works out to
      // exactly the pan law in `stereoPanFromY` that the DAW uses for its AAC
      // fallback track. Asserted in the tests rather than left as a claim.
      const merger = ctx.createChannelMerger(2);
      for (const [channel, direction] of [
        [0, [-1, 0, 0]],
        [1, [1, 0, 0]],
      ] as ReadonlyArray<readonly [number, Direction]>) {
        const speaker = ctx.createGain();
        speaker.gain.value = 1;
        this.connectSpeaker(speaker, direction, 2);
        speaker.connect(merger, 0, channel);
      }
      merger.connect(this.output);
      return;
    }

    const n = FOA_VIRTUAL_SPEAKERS.length;
    for (const direction of FOA_VIRTUAL_SPEAKERS) {
      const speaker = ctx.createGain();
      speaker.gain.value = 1;
      this.connectSpeaker(speaker, direction, n);
      const [ux, uy, uz] = direction;

      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      // Placed at unit distance with `refDistance` 1, so the inverse model
      // returns exactly 1. Distance is the encoder's job; a second
      // attenuation here would apply it twice.
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.rolloffFactor = 1;
      setPannerPosition(panner, ux, uy, uz);
      speaker.connect(panner);
      panner.connect(this.output);
      this.panners.push(panner);
    }
  }

  /**
   * Feeds one virtual speaker its share of the rotated field, using the same
   * `foaSpeakerWeights` the offline decode uses. One implementation, so a
   * browser and a Node render cannot disagree about where a source is.
   */
  private connectSpeaker(speaker: GainNode, direction: Direction, count: number): void {
    const k = foaSpeakerWeights(direction, count);
    this.connectWeighted(this.rot.w, speaker, k.w);
    this.connectWeighted(this.rot.y, speaker, k.y);
    this.connectWeighted(this.rot.z, speaker, k.z);
    this.connectWeighted(this.rot.x, speaker, k.x);
  }

  private connectWeighted(from: GainNode, to: GainNode, weight: number): void {
    if (weight === 0) return;
    const gain = this.context.createGain();
    gain.gain.value = weight;
    from.connect(gain);
    gain.connect(to);
  }
}

/**
 * Safari only grew `PannerNode.positionX` in 14.1 and still ships
 * `setPosition` everywhere; the deprecated call is the one that works in more
 * places, so it is the fallback rather than the other way round.
 */
function setPannerPosition(panner: PannerNode, x: number, y: number, z: number): void {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
    return;
  }
  panner.setPosition(x, y, z);
}
