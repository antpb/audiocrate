/**
 * The audio-thread half of a spatial source: mono in, first-order ambisonics
 * out, with the position as audio-rate `AudioParam`s.
 *
 * ## Why this is a worklet and not a graph of native nodes
 *
 * Encoding to FOA is four multiplications, which a `GainNode` each could do.
 * What a `GainNode` cannot do is derive those four numbers from a position,
 * because the mapping normalizes by `1/|p|` and then applies distance
 * attenuation. Both are nonlinear, so there is no way to patch an LFO into a
 * gain and get an orbit out.
 *
 * The alternative is to compute the gains on the main thread and schedule
 * them, which is what a control-rate automation path does. That is the
 * editor's existing CV route: an analyser read in the meter loop at roughly
 * 20 Hz. It is fine for a slow drift and audibly steppy for a fast one, and a
 * moving source is the entire point of the feature.
 *
 * So position lives here, as `a-rate` params. An LFO patched into `x` is then
 * sample accurate, costs no messages, and cannot tear against the block
 * boundary.
 *
 * ## Why the output is B-format rather than stereo
 *
 * A source could equally do its own HRTF and emit stereo. Then every source
 * pays for a binaural render, and rotating the listener means recomputing
 * every source's position rather than rotating one field.
 *
 * Emitting B-format instead means the cable carries the direction. Summing
 * two spatial sources is adding four channels, so `SpatialBus` needs no
 * registry of who is connected and no side channel to learn where they are.
 * One rotation and one decode then serve any number of sources.
 */
import { DISTANCE_MODELS, distanceAttenuation, type DistanceModel } from '../distance';
import { FOA_W, foaGainsFromDirection } from '../foa';

/** Processor name `SpatialBus` looks for unless told otherwise. */
export const FOA_ENCODER_PROCESSOR = 'crate-foa-encoder';

/** Channel order of this processor's output: ACN, as `foa.ts` documents. */
export const FOA_CHANNELS = ['W', 'Y', 'Z', 'X'] as const;

/**
 * `distanceModel` is a k-rate index into this list rather than three separate
 * params, because a host picks a model once and then never touches it, and
 * three extra knobs on every spatial node is a worse trade than a short
 * enum. Extending it is additive: append, never reorder, since a saved patch
 * stores the index.
 */
const DISTANCE_MODEL_BY_INDEX: readonly DistanceModel[] = [
  DISTANCE_MODELS.preview,
  DISTANCE_MODELS.webHrtf,
];

/** Reads an `a-rate` param, which the browser may still hand over as length 1. */
function at(param: Float32Array | undefined, i: number): number {
  if (param === undefined || param.length === 0) return 0;
  return param.length === 1 ? param[0]! : param[i]!;
}

/**
 * Names already registered in this worklet global.
 *
 * `registerProcessor` throws on a duplicate name, and `defineCrateVoiceProcessor`
 * calls this so that every crate worklet has an encoder in it. A host that
 * builds a custom entry with extra kernels legitimately calls that factory,
 * and should not have to know it must not also call this one.
 */
const registered = new Set<string>();

/**
 * Registers the FOA encoder under `processorName`.
 *
 * Idempotent per name. Called for you by `defineCrateVoiceProcessor`, so a
 * host only calls it directly to register a second copy under another name.
 */
export function defineCrateFoaEncoder(processorName: string = FOA_ENCODER_PROCESSOR): void {
  if (registered.has(processorName)) return;
  registered.add(processorName);

  class CrateFoaEncoder extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        // Defaults put a new source at `NAMED_POSITIONS.center`: one metre
        // dead ahead. A source that appears at the origin would be
        // omnidirectional, which looks like the node doing nothing.
        { name: 'x', defaultValue: 0, minValue: -1000, maxValue: 1000, automationRate: 'a-rate' },
        { name: 'y', defaultValue: 0, minValue: -1000, maxValue: 1000, automationRate: 'a-rate' },
        { name: 'z', defaultValue: -1, minValue: -1000, maxValue: 1000, automationRate: 'a-rate' },
        { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 8, automationRate: 'a-rate' },
        // Omnidirectional, rotation-immune: the DAW's "global" track. Not a
        // branch around the encoder but a value through it, so switching it
        // mid-play cannot restructure the graph under the audio thread.
        { name: 'global', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        {
          name: 'distanceModel',
          defaultValue: 0,
          minValue: 0,
          maxValue: DISTANCE_MODEL_BY_INDEX.length - 1,
          automationRate: 'k-rate',
        },
      ];
    }

    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean {
      const output = outputs[0];
      if (!output || output.length < 4) return true;
      const w = output[0]!;
      const yOut = output[1]!;
      const zOut = output[2]!;
      const xOut = output[3]!;
      const frames = w.length;

      const input = inputs[0];
      const inL = input?.[0];
      const inR = input?.[1];

      const px = parameters.x;
      const py = parameters.y;
      const pz = parameters.z;
      const pGain = parameters.gain;
      const isGlobal = at(parameters.global, 0) >= 0.5;
      const modelIndex = Math.round(at(parameters.distanceModel, 0));
      const model = DISTANCE_MODEL_BY_INDEX[modelIndex] ?? DISTANCE_MODELS.preview;

      // A global source has no direction and takes no distance attenuation:
      // it is the full-width bed, and attenuating it by an accidental
      // position would make "global" quietly mean "global and further away".
      if (isGlobal) {
        for (let i = 0; i < frames; i++) {
          const s = monoAt(inL, inR, i) * at(pGain, i);
          w[i] = FOA_W * s;
          yOut[i] = 0;
          zOut[i] = 0;
          xOut[i] = 0;
        }
        return true;
      }

      for (let i = 0; i < frames; i++) {
        const x = at(px, i);
        const y = at(py, i);
        const z = at(pz, i);
        // Recomputed per sample on purpose. Holding the gains for a block
        // and crossfading is cheaper and reintroduces exactly the stepping
        // this processor exists to remove, at 375 Hz instead of 20.
        const gains = foaGainsFromDirection(x, y, z);
        const distance = Math.hypot(x, y, z);
        const s = monoAt(inL, inR, i) * at(pGain, i) * distanceAttenuation(distance, model);
        w[i] = gains.w * s;
        yOut[i] = gains.y * s;
        zOut[i] = gains.z * s;
        xOut[i] = gains.x * s;
      }
      return true;
    }
  }

  registerProcessor(processorName, CrateFoaEncoder);
}

/**
 * Averages, rather than sums, so a stereo source is not 6 dB louder than the
 * same material in mono. A spatial source is a point: it has one signal, and
 * the stereo width of whatever fed it is information this encoder cannot
 * represent and should not smuggle through as level.
 */
function monoAt(left: Float32Array | undefined, right: Float32Array | undefined, i: number): number {
  if (left === undefined) return 0;
  const l = left[i] ?? 0;
  if (right === undefined) return l;
  return (l + (right[i] ?? 0)) * 0.5;
}
