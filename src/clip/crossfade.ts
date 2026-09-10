import { clipTimelineDurationSec, type WarpSegment } from './region';
import type { FadeCurve } from './fades';

function stretchRatioOf(clip: CrossfadeClipDraft): number {
  return Number.isFinite(clip.stretchRatio) && clip.stretchRatio > 0 ? clip.stretchRatio : 1;
}

/**
 * When B's head is pulled earlier, warp markers would be rewritten and
 * then rebuilt. Audiocrate stores already-projected segments, so this is the
 * equivalent rewrite: a synthetic first segment covers the pulled
 * headroom at the plain stretch ratio, and every original segment's
 * clip-local origin shifts by `overlapSec` so song positions (and B's
 * timeline end) stay put.
 */
function pullWarpSegmentsForHeadroom(
  segs: WarpSegment[],
  newTrimStartSec: number,
  oldTrimStartSec: number,
  overlapSec: number,
  stretchRatio: number,
): WarpSegment[] {
  const shifted = segs.map((seg) => ({ ...seg, localOffsetSec: seg.localOffsetSec + overlapSec }));
  const fileSpan = oldTrimStartSec - newTrimStartSec;
  if (fileSpan <= 0 || overlapSec <= 0) return shifted;
  return [
    {
      fileStartSec: newTrimStartSec,
      fileEndSec: oldTrimStartSec,
      ratio: stretchRatio,
      localOffsetSec: 0,
    },
    ...shifted,
  ];
}

/** Adjacent clips within 10 ms are treated as abutting. */
export const CROSSFADE_ADJACENCY_EPS_SEC = 0.01;

export interface CrossfadeClipDraft {
  id: number;
  offsetSec: number;
  trimStartSec: number;
  trimEndSec: number;
  stretchRatio: number;
  warpSegments: WarpSegment[] | null;
  fadeInSec: number;
  fadeOutSec: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
  gainDb: number;
  crossfadeToNextSec: number;
  crossfadeCurve: FadeCurve;
}

function timelineDur(clip: CrossfadeClipDraft): number {
  return clipTimelineDurationSec({
    trimStartSec: clip.trimStartSec,
    trimEndSec: clip.trimEndSec,
    stretchRatio: clip.stretchRatio,
    warpSegments: clip.warpSegments,
  });
}

function findAdjacentNext(clips: CrossfadeClipDraft[], clip: CrossfadeClipDraft): CrossfadeClipDraft | null {
  const endSec = clip.offsetSec + timelineDur(clip);
  let best: CrossfadeClipDraft | null = null;
  let bestGap = CROSSFADE_ADJACENCY_EPS_SEC + 1;
  for (const other of clips) {
    if (other.id === clip.id) continue;
    const gap = Math.abs(other.offsetSec - endSec);
    if (gap <= CROSSFADE_ADJACENCY_EPS_SEC && gap < bestGap) {
      best = other;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Copies the drafts, never the live Clip objects. A to B: A fades out
 * over N, B is pulled N earlier from pre-trim headroom and fades in over
 * N. User fades on those edges are kept when longer. B's timeline end
 * does not move. Warped B gets its segments rewritten so the pulled head
 * is in the map.
 */
export function projectClipCrossfades(clips: CrossfadeClipDraft[]): CrossfadeClipDraft[] {
  if (!clips.some((c) => c.crossfadeToNextSec > 0)) return clips;
  const sorted = clips
    .map((c) => ({ ...c, warpSegments: c.warpSegments ? c.warpSegments.map((seg) => ({ ...seg })) : null }))
    .sort((a, b) => a.offsetSec - b.offsetSec);
  for (const a of sorted) {
    if (a.crossfadeToNextSec <= 0) continue;
    const b = findAdjacentNext(sorted, a);
    if (!b) continue;
    const curve = a.crossfadeCurve;
    const n = Math.min(a.crossfadeToNextSec, timelineDur(a), timelineDur(b));
    if (n <= 0) continue;
    const ratioB = stretchRatioOf(b);
    const headroomSec = b.trimStartSec * ratioB;
    const overlap = Math.max(0, Math.min(n, headroomSec));
    a.fadeOutSec = Math.max(a.fadeOutSec, n);
    a.fadeOutCurve = curve;
    const oldTrimStartB = b.trimStartSec;
    b.offsetSec -= overlap;
    b.trimStartSec = Math.max(0, b.trimStartSec - overlap / ratioB);
    b.fadeInSec = Math.max(b.fadeInSec, n);
    b.fadeInCurve = curve;
    if (overlap > 0 && b.warpSegments && b.warpSegments.length > 0) {
      b.warpSegments = pullWarpSegmentsForHeadroom(
        b.warpSegments,
        b.trimStartSec,
        oldTrimStartB,
        overlap,
        ratioB,
      );
    }
  }
  return sorted;
}
