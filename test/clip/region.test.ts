import { describe, expect, it } from 'vitest';
import { clipPlaybackWindows, clipTimelineDurationSec, warpSegmentsFromMs } from '../../src/clip/region';

describe('clipTimelineDurationSec', () => {
  it('multiplies the file trim by stretchRatio', () => {
    expect(clipTimelineDurationSec({ trimStartSec: 1, trimEndSec: 3, stretchRatio: 2 })).toBe(4);
    expect(clipTimelineDurationSec({ trimStartSec: 0, trimEndSec: 1 })).toBe(1);
  });

  it('uses warp segments instead of stretchRatio when they are present', () => {
    const warp = warpSegmentsFromMs([
      { fileStartMs: 0, fileEndMs: 500, ratio: 2, localOffsetMs: 0 },
      { fileStartMs: 500, fileEndMs: 1000, ratio: 0.5, localOffsetMs: 1000 },
    ]);
    expect(clipTimelineDurationSec({ trimStartSec: 0, trimEndSec: 1, stretchRatio: 4, warpSegments: warp })).toBeCloseTo(
      1.25,
    );
  });
});

describe('clipPlaybackWindows', () => {
  it('schedules an unstretched clip in file time', () => {
    const [win] = clipPlaybackWindows({
      offsetSec: 2,
      trimStartSec: 0.5,
      trimEndSec: 2.5,
      playheadSec: 0,
    });
    expect(win).toMatchObject({
      whenSec: 2,
      fileOffsetSec: 0.5,
      fileDurationSec: 2,
      playbackRate: 1,
    });
  });

  it('seeks in timeline time and converts back to file time under stretch', () => {
    const [win] = clipPlaybackWindows({
      offsetSec: 0,
      trimStartSec: 1,
      trimEndSec: 3,
      stretchRatio: 2,
      playheadSec: 1,
    });
    expect(win!.whenSec).toBe(0);
    expect(win!.fileOffsetSec).toBeCloseTo(1.5);
    expect(win!.fileDurationSec).toBeCloseTo(1.5);
    expect(win!.playbackRate).toBeCloseTo(0.5);
  });

  it('drops windows that have already ended', () => {
    expect(
      clipPlaybackWindows({
        offsetSec: 0,
        trimStartSec: 0,
        trimEndSec: 1,
        playheadSec: 1,
      }),
    ).toEqual([]);
  });
});
