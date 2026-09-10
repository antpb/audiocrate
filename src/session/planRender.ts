/**
 * Rendering a scene plan to samples.
 *
 * `schedulePlan` proves two implementations agree about *numbers*. This proves
 * they agree about *audio*, which is the claim the whole session-as-data arc
 * is for: the same plan, bounced in two languages, sample for sample.
 *
 * ## Why the sources are generated rather than loaded
 *
 * A plan names sources by id and a host resolves them. A conformance test
 * cannot ship a wav file to two languages and expect their decoders to agree,
 * because then it would be testing decoders. So a source here is a formula
 * both sides evaluate: given a file position in seconds, what sample is there.
 *
 * `ramp` is the important one and it is chosen, not arbitrary. Its sample at
 * file position `t` is `t`, so **a rendered sample is the file position it
 * came from**. A clip placed one frame late, read at the wrong rate, or
 * skipped into by the wrong amount does not produce a subtly different
 * waveform; it produces a visibly wrong number. That turns a placement bug
 * from something you have to listen for into something the diff prints.
 *
 * ## What is deliberately not here
 *
 * **Pan.** A pan law is a mixer decision already covered by the `panLaw` ASL
 * node under the ASL fixture, and folding it in would mean this file also
 * asserted a `cos`/`sin` pair. The render is mono: every track sums to one
 * bus. Pan travels in the schedule for a host to apply.
 *
 * **Inserts.** A plan carries their reported latency and not their DSP,
 * because their DSP is a graph and graphs are already conformant.
 *
 * ## The summation order is part of the contract
 *
 * Floating-point addition is not associative, so "sum every contribution" is
 * not a specification. Tracks in plan order, clips in track order, windows in
 * clip order, accumulating into one running total, then master gain applied
 * once at the end. Two implementations that follow that produce identical
 * bits; two that do not are entitled to differ in the last place, and then
 * nobody can tell a rounding from a bug.
 */
import { schedulePlan, type ScenePlan } from './ScenePlan';

export type PlanSourceSpec =
  /** `sample(t) = t`, so a rendered sample states the file position it came from. */
  | { kind: 'ramp'; durationSec: number }
  /** Piecewise constant. A misplaced read lands on a different plateau. */
  | { kind: 'steps'; durationSec: number; stepSec: number }
  /** The one transcendental source, for a case that looks like audio. */
  | { kind: 'sine'; durationSec: number; hz: number };

export interface PlanRenderOptions {
  sampleRate: number;
  durationSec: number;
  /** Where the plan is played from, relative to its transport origin. */
  atSec?: number;
}

export function sourceDurationSec(spec: PlanSourceSpec): number {
  return spec.durationSec;
}

/**
 * A source as a buffer, at the render's sample rate.
 *
 * Generated rather than decoded so that two languages evaluating the same
 * formula start from the same samples. `steps` uses `floor`, which is exact,
 * and `sine` is the only kind that reaches libm.
 */
export function generateSource(spec: PlanSourceSpec, sampleRate: number): Float32Array {
  const frames = Math.max(0, Math.round(spec.durationSec * sampleRate));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    if (spec.kind === 'ramp') out[i] = t;
    else if (spec.kind === 'steps') out[i] = Math.floor(t / spec.stepSec);
    else out[i] = Math.sin(2 * Math.PI * spec.hz * t);
  }
  return out;
}

/**
 * One sample from a source at an arbitrary file position.
 *
 * Linear interpolation between the two neighbouring frames, zero outside the
 * source. Stated explicitly because a resampling rule that is merely whatever
 * each implementation happened to write is not a contract: nearest-neighbour
 * and linear differ audibly on a stretched clip and agree exactly at rate 1,
 * so the disagreement would hide in every unstretched case.
 */
export function sampleSourceAt(source: Float32Array, fileSec: number, sampleRate: number): number {
  if (!(fileSec >= 0)) return 0;
  const position = fileSec * sampleRate;
  const index = Math.floor(position);
  if (index < 0 || index >= source.length) return 0;
  const next = index + 1;
  const frac = position - index;
  const a = source[index]!;
  const b = next < source.length ? source[next]! : 0;
  return a + (b - a) * frac;
}

/**
 * A plan, from its playhead, as mono samples.
 *
 * The order of accumulation is the contract. See the note at the top.
 */
export function renderPlan(
  plan: ScenePlan,
  sources: Record<string, PlanSourceSpec>,
  options: PlanRenderOptions,
): Float32Array {
  const { sampleRate, durationSec } = options;
  const atSec = options.atSec ?? 0;
  const buffers = new Map<string, Float32Array>();
  for (const [id, spec] of Object.entries(sources)) {
    buffers.set(id, generateSource(spec, sampleRate));
  }

  const schedule = schedulePlan(plan, atSec, (id) => sources[id]?.durationSec);
  const frames = Math.max(0, Math.round(durationSec * sampleRate));
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    let acc = 0;
    for (const track of schedule.tracks) {
      if (track.gain === 0) continue;
      for (const clip of track.clips) {
        const source = buffers.get(clip.source);
        if (!source) continue;
        for (const window of clip.windows) {
          // Timeline extent of a window is its file extent divided by the
          // playback rate: a rate of 0.5 makes two file seconds last four.
          const timelineDurationSec = window.fileDurationSec / window.playbackRate;
          if (t < window.whenSec) continue;
          if (t >= window.whenSec + timelineDurationSec) continue;
          const fileSec = window.fileOffsetSec + (t - window.whenSec) * window.playbackRate;
          acc += sampleSourceAt(source, fileSec, sampleRate) * clip.gain * track.gain;
        }
      }
    }
    out[i] = acc * schedule.masterGain;
  }
  return out;
}
