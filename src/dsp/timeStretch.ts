/**
 * Pitch-preserving time stretch.
 *
 * ## Why this exists
 *
 * Three implementations of "stretch a clip" disagreed:
 *
 *   - **iOS** bakes the clip through `AVAudioUnitTimePitch` at `rate = 1/ratio`
 *     with `pitch = 0`, so the clip gets longer and stays in tune. This is the
 *     reference behaviour.
 *   - **The web** set `AudioBufferSourceNode.playbackRate`, which is varispeed:
 *     a clip stretched to double length also dropped an octave.
 *   - **Android** dropped `stretchRatio` on the floor, so a stretched clip
 *     played at its original length and everything after it landed early.
 *
 * iOS is right and stays as it is: `AVAudioUnitTimePitch` is better than
 * anything worth writing here, and replacing it would regress the platform
 * that already works. What is mirrored is the **model**, which is the part
 * that actually made iOS immune: *bake the stretch into the buffer, then place
 * the buffer at rate 1.* A host that does that cannot invert a ratio, cannot
 * double-apply one, and cannot change pitch by accident.
 *
 * Exact sample equality with Apple's implementation is not the goal and is not
 * achievable. Behaviour parity is: longer, in tune, and the same length on
 * every platform.
 *
 * ## The algorithm
 *
 * WSOLA (waveform similarity overlap-add). Analysis frames are taken at a hop
 * derived from the ratio, each is nudged within a small search window to the
 * offset that best matches what has already been written, and the result is
 * overlap-added under a Hann window.
 *
 * The similarity search is the whole difference between this and plain SOLA.
 * Without it the overlap lands at an arbitrary phase and the output has the
 * smeared, flanged quality that `homecrate drum`'s `TimeStretch.swift`
 * deliberately keeps as an S950 character. That is a good effect and a bad
 * default.
 *
 * **Channels share one hop schedule.** The best offset is chosen from the
 * summed correlation across channels, not per channel, because independently
 * aligned channels drift apart and a stereo take collapses toward mono as the
 * two sides decorrelate.
 *
 * ## Conventions
 *
 * `ratio` is the **output length factor**, matching `stretchRatio` everywhere
 * else in crate and homecrate: a clip's timeline extent is
 * `(trimEnd - trimStart) * ratio`. So a ratio of 2 makes the clip twice as
 * long and half as fast, and a ratio of 1 returns the input unchanged rather
 * than a rounded approximation of it.
 *
 * The range is clamped to the same [0.25, 4] iOS uses. Outside that, overlap
 * add stops sounding like the source and starts sounding like an effect.
 */

/** The same bounds `offlineStretchBuffer` clamps to on iOS. */
export const MIN_STRETCH_RATIO = 0.25;
export const MAX_STRETCH_RATIO = 4;

/**
 * Analysis frame length in samples, at the reference rate.
 *
 * Long enough to hold a period of the lowest pitch that matters (about 43 Hz
 * at 44.1 kHz) so the similarity search has a period to lock onto, and short
 * enough that a transient is smeared across only a few milliseconds.
 */
export const STRETCH_FRAME = 1024;

/** Hann, precomputed per length. Deterministic, so two runs agree. */
function hann(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  }
  return window;
}

export function clampStretchRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_STRETCH_RATIO, Math.max(MIN_STRETCH_RATIO, ratio));
}

/** Output length for a stretch, which a caller needs before it allocates. */
export function stretchedLength(inputFrames: number, ratio: number): number {
  return Math.max(0, Math.round(inputFrames * clampStretchRatio(ratio)));
}

export interface TimeStretchOptions {
  /** Analysis frame length. Defaults to `STRETCH_FRAME`. */
  frame?: number;
  /**
   * How far a frame may be nudged to find a better overlap, in samples.
   * Defaults to a quarter of the frame, which covers a period of anything
   * above roughly 170 Hz at 44.1 kHz.
   */
  search?: number;
}

/**
 * Stretches interleaved-by-channel audio, returning new arrays.
 *
 * `channels` is one array per channel, all the same length. A ratio of exactly
 * 1 returns copies rather than the inputs, so a caller can always own the
 * result without checking.
 */
export function timeStretch(
  channels: readonly Float32Array[],
  ratio: number,
  options: TimeStretchOptions = {},
): Float32Array[] {
  const clamped = clampStretchRatio(ratio);
  const inputFrames = channels[0]?.length ?? 0;
  if (channels.length === 0 || inputFrames === 0) return channels.map((c) => new Float32Array(c));
  if (clamped === 1) return channels.map((c) => Float32Array.from(c));

  const frame = Math.max(64, Math.floor(options.frame ?? STRETCH_FRAME));
  const search = Math.max(0, Math.floor(options.search ?? frame / 4));
  // Half-frame synthesis hop: consecutive windows overlap by 50%, which is
  // where a Hann pair sums to unity and the output needs no normalisation.
  const synthesisHop = Math.floor(frame / 2);
  const analysisHop = Math.max(1, Math.round(synthesisHop / clamped));

  const outputFrames = stretchedLength(inputFrames, clamped);
  const window = hann(frame);
  const out = channels.map(() => new Float32Array(outputFrames));

  let readAt = 0;
  let writeAt = 0;
  // Where the previous frame ended, so the next one can be matched against the
  // signal that is about to be overlapped rather than against silence.
  let expected = 0;

  while (writeAt < outputFrames) {
    let bestOffset = 0;
    if (search > 0 && writeAt > 0) {
      // Pick the offset whose overlap region best matches what was already
      // written. Summed across channels so the two sides stay locked.
      let bestScore = -Infinity;
      const low = Math.max(-search, -readAt);
      const high = search;
      for (let offset = low; offset <= high; offset++) {
        const start = readAt + offset;
        if (start < 0 || start + synthesisHop > inputFrames) continue;
        let score = 0;
        for (const channel of channels) {
          for (let i = 0; i < synthesisHop; i += 4) {
            const written = writeAt + i;
            if (written >= outputFrames) break;
            score += channel[start + i]! * (expected + i < inputFrames ? channel[expected + i]! : 0);
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestOffset = offset;
        }
      }
    }

    const start = Math.max(0, Math.min(inputFrames - 1, readAt + bestOffset));
    for (let c = 0; c < channels.length; c++) {
      const source = channels[c]!;
      const target = out[c]!;
      for (let i = 0; i < frame; i++) {
        const from = start + i;
        const to = writeAt + i;
        if (to >= outputFrames) break;
        if (from >= inputFrames) break;
        target[to] += source[from]! * window[i]!;
      }
    }

    expected = start + synthesisHop;
    readAt += analysisHop;
    writeAt += synthesisHop;
    if (readAt >= inputFrames) break;
  }

  return out;
}

/**
 * A clip's audio baked into timeline time.
 *
 * This is the iOS model, mirrored: `AudioRecorderManager` builds a
 * `stretchedTrimmedClipBuffer` (or a `warpedTrimmedClipBuffer`) and then seeks
 * into it with a plain timeline offset. Nothing downstream knows a ratio was
 * ever involved, which is exactly why nothing downstream can invert one,
 * double-apply one, or turn one into a pitch change.
 *
 * The returned channels are in timeline time: one output second is one second
 * of the song. A caller places them at rate 1 and stops carrying the ratio.
 *
 * `warpSegments` replace `stretchRatio` entirely rather than compounding with
 * it, the same rule the rest of crate follows. Their positions are relative to
 * the buffer passed in, so a caller that decoded a slice of the file must have
 * already rebased them onto it.
 */
export function bakeClipStretch(
  channels: readonly Float32Array[],
  sampleRate: number,
  opts: {
    stretchRatio?: number;
    warpSegments?: ReadonlyArray<{
      fileStartSec: number;
      fileEndSec: number;
      ratio: number;
      localOffsetSec: number;
    }> | null;
  },
): Float32Array[] {
  const segments = opts.warpSegments && opts.warpSegments.length > 0 ? opts.warpSegments : null;
  if (!segments) {
    return timeStretch(channels, opts.stretchRatio ?? 1);
  }
  if (channels.length === 0) return [];

  const sourceFrames = channels[0]!.length;
  const frameOf = (seconds: number) => Math.max(0, Math.round(seconds * sampleRate));

  // Each segment is stretched on its own and written at its own timeline
  // offset, which is what makes the map piecewise rather than a single ratio.
  const baked = segments.map((segment) => {
    const from = Math.min(sourceFrames, frameOf(segment.fileStartSec));
    const to = Math.min(sourceFrames, frameOf(segment.fileEndSec));
    const slice = channels.map((channel) => channel.subarray(from, Math.max(from, to)));
    return {
      at: frameOf(segment.localOffsetSec),
      audio: timeStretch(slice, segment.ratio),
    };
  });

  let outputFrames = 0;
  for (const piece of baked) outputFrames = Math.max(outputFrames, piece.at + (piece.audio[0]?.length ?? 0));

  const out = channels.map(() => new Float32Array(outputFrames));
  for (const piece of baked) {
    for (let c = 0; c < out.length; c++) {
      const target = out[c]!;
      const source = piece.audio[c];
      if (!source) continue;
      for (let i = 0; i < source.length; i++) {
        const at = piece.at + i;
        if (at >= outputFrames) break;
        // Summed rather than overwritten: adjacent segments abut exactly, and
        // a project whose segments overlap by a frame should crossfade rather
        // than have the later one erase the earlier one's tail.
        target[at] += source[i]!;
      }
    }
  }
  return out;
}
