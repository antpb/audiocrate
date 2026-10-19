/**
 * The random numbers behind `noise` and `random`, made reproducible.
 *
 * Both nodes used to call `Math.random()`, so a patch using them could not be
 * bounced twice to the same file, compared against the Swift interpreter, or
 * be the same sound on two visitors' machines in a seeded XR world. Now each
 * one draws from its own stream, and a stream is a pure function of three
 * integers:
 *
 * - the **voice seed** (`CompiledVoice.createState({ seed })`, 0 by default);
 * - the node's **rank** among the graph's random nodes in structural order
 *   (`randomRanks` in compile.ts): first visit in a depth-first walk from the
 *   output, inputs in sorted name order. Not ids and not plan slots, because
 *   the catalog renumbers ids, flatten mints new ones in each language, and
 *   Swift's own walk follows dictionary order. The shape is the only thing
 *   every host agrees on;
 * - the output **channel**, so a stereo insert's two sides are two noises
 *   rather than one noise twice.
 *
 * Everything below is 32-bit integer arithmetic (`Math.imul`, shifts), which
 * Swift reproduces exactly with `UInt32` wrapping operators. The draw is the
 * integer divided by 2^32, which both languages do exactly in a double. That
 * is what lets the conformance fixture compare noise at zero tolerance.
 *
 * Matched line for line by `Rng.swift` in CrateASL.
 */

/** The seed a voice gets when nobody chooses one. */
export const DEFAULT_VOICE_SEED = 0;

/** A seed as the generator uses it: an unsigned 32-bit integer. */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return DEFAULT_VOICE_SEED;
  // ECMAScript ToUint32: truncate toward zero, then wrap modulo 2^32, exactly.
  // Negative seeds are allowed and wrap like the integer they are.
  return seed >>> 0;
}

/**
 * The starting state of one node's stream. A murmur3 finalizer over the three
 * inputs, so neighbouring seeds, ranks and channels land far apart.
 */
export function streamSeed(voiceSeed: number, rank: number, lane: number): number {
  let h = (voiceSeed ^ Math.imul(rank + 1, 0x9e3779b1) ^ Math.imul(lane + 1, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A stream's state, held in the node's memory. */
export interface RngState {
  rng: number;
}

/**
 * The next draw in [0, 1), advancing the stream. mulberry32: one add, two
 * multiplies and a few shifts, which is cheaper than `Math.random()` in V8.
 */
export function nextUniform(state: RngState): number {
  const s = (state.rng + 0x6d2b79f5) | 0;
  state.rng = s >>> 0;
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
