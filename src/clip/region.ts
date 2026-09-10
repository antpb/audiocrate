/**
 * Clip time contract. Offset is timeline, trim is file, timeline extent is
 * (trimEnd - trimStart) * stretchRatio. Warp segments, when present,
 * replace stretchRatio (never both).
 */

export interface SampleRegion {
  trimStartSec: number;
  trimEndSec: number | null;
}

export interface WarpSegment {
  fileStartSec: number;
  fileEndSec: number;
  ratio: number;
  localOffsetSec: number;
}

export interface ClipPlaybackWindow {
  /** Seconds after playhead=0 to start this window (before PDC). */
  whenSec: number;
  fileOffsetSec: number;
  fileDurationSec: number;
  playbackRate: number;
}

function saneRatio(ratio: number): number {
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function resolveTrimEndSec(region: SampleRegion, bufferDurationSec: number): number {
  if (region.trimEndSec != null && region.trimEndSec > region.trimStartSec) {
    return Math.min(region.trimEndSec, bufferDurationSec);
  }
  return bufferDurationSec;
}

export function clipTimelineDurationSec(opts: {
  trimStartSec: number;
  trimEndSec: number;
  stretchRatio?: number;
  warpSegments?: WarpSegment[] | null;
}): number {
  const segs = opts.warpSegments;
  if (segs && segs.length > 0) {
    const last = segs[segs.length - 1]!;
    return last.localOffsetSec + (last.fileEndSec - last.fileStartSec) * saneRatio(last.ratio);
  }
  return Math.max(0, opts.trimEndSec - opts.trimStartSec) * saneRatio(opts.stretchRatio ?? 1);
}

export function clipPlaybackWindows(opts: {
  offsetSec: number;
  trimStartSec: number;
  trimEndSec: number;
  stretchRatio?: number;
  warpSegments?: WarpSegment[] | null;
  playheadSec: number;
}): ClipPlaybackWindow[] {
  const segs =
    opts.warpSegments && opts.warpSegments.length > 0
      ? opts.warpSegments
      : [
          {
            fileStartSec: opts.trimStartSec,
            fileEndSec: opts.trimEndSec,
            ratio: saneRatio(opts.stretchRatio ?? 1),
            localOffsetSec: 0,
          },
        ];

  const out: ClipPlaybackWindow[] = [];
  for (const seg of segs) {
    const ratio = saneRatio(seg.ratio);
    const fileDur = Math.max(0, seg.fileEndSec - seg.fileStartSec);
    if (fileDur <= 0) continue;
    const timelineStart = opts.offsetSec + seg.localOffsetSec;
    const timelineEnd = timelineStart + fileDur * ratio;
    if (opts.playheadSec >= timelineEnd) continue;
    const whenSec = Math.max(0, timelineStart - opts.playheadSec);
    const skipFile = Math.max(0, opts.playheadSec - timelineStart) / ratio;
    const fileRemain = fileDur - skipFile;
    if (fileRemain <= 0) continue;
    out.push({
      whenSec,
      fileOffsetSec: seg.fileStartSec + skipFile,
      fileDurationSec: fileRemain,
      playbackRate: 1 / ratio,
    });
  }
  return out;
}

export function warpSegmentsFromMs(
  raw: Array<{ fileStartMs: number; fileEndMs: number; ratio: number; localOffsetMs: number }> | null | undefined,
): WarpSegment[] | null {
  if (!raw || raw.length === 0) return null;
  return raw.map((seg) => ({
    fileStartSec: seg.fileStartMs / 1000,
    fileEndSec: seg.fileEndMs / 1000,
    ratio: saneRatio(seg.ratio),
    localOffsetSec: seg.localOffsetMs / 1000,
  }));
}
