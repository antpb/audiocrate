import { describe, expect, it } from 'vitest';
import { applyClipGainAndFades, clipGainLinear, fadeShape } from '../../src/clip/fades';
import { projectClipCrossfades, type CrossfadeClipDraft } from '../../src/clip/crossfade';

function bufferOf(samples: number[]): {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData: (ch: number) => Float32Array;
} {
  const data = new Float32Array(samples);
  return {
    sampleRate: samples.length,
    length: samples.length,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

function draft(partial: Partial<CrossfadeClipDraft> & Pick<CrossfadeClipDraft, 'id' | 'offsetSec'>): CrossfadeClipDraft {
  return {
    trimStartSec: 0,
    trimEndSec: 1,
    stretchRatio: 1,
    warpSegments: null,
    fadeInSec: 0,
    fadeOutSec: 0,
    fadeInCurve: 'linear',
    fadeOutCurve: 'linear',
    gainDb: 0,
    crossfadeToNextSec: 0,
    crossfadeCurve: 'equalPower',
    ...partial,
  };
}

describe('fadeShape', () => {
  it('matches native linear / equalPower / sCurve', () => {
    expect(fadeShape(0.5, 'linear')).toBeCloseTo(0.5);
    expect(fadeShape(0.5, 'equalPower')).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(fadeShape(0.5, 'sCurve')).toBeCloseTo(0.5);
    expect(fadeShape(0, 'equalPower')).toBe(0);
    expect(fadeShape(1, 'equalPower')).toBeCloseTo(1);
  });
});

describe('clipGainLinear', () => {
  it('treats -60 dB and below as silence', () => {
    expect(clipGainLinear(-60)).toBe(0);
    expect(clipGainLinear(-80)).toBe(0);
    expect(clipGainLinear(0)).toBe(1);
    expect(clipGainLinear(-6)).toBeCloseTo(10 ** (-6 / 20));
  });
});

describe('applyClipGainAndFades', () => {
  it('does not mutate the source buffer', () => {
    const src = bufferOf([1, 1, 1, 1]);
    const out = applyClipGainAndFades(src, { fadeInSec: 1, fadeInCurve: 'linear' });
    expect(Array.from(src.getChannelData(0))).toEqual([1, 1, 1, 1]);
    expect(out.getChannelData(0)[0]).toBeCloseTo(0);
    expect(out.getChannelData(0)[1]).toBeCloseTo(0.25);
  });

  it('anchors fade-out at trim end so a mid-clip seek still hears the tail', () => {
    const src = bufferOf([1, 1, 1, 1]);
    const out = applyClipGainAndFades(src, {
      fadeOutSec: 1,
      fadeOutCurve: 'linear',
      trimStartSec: 0,
      trimEndSec: 1,
    });
    expect(out.getChannelData(0)[3]).toBeCloseTo(0.25);
  });
});

describe('projectClipCrossfades', () => {
  it('fades A out and pulls B earlier from pre-trim headroom', () => {
    const [a, b] = projectClipCrossfades([
      draft({ id: 1, offsetSec: 0, trimEndSec: 1, crossfadeToNextSec: 0.2 }),
      draft({ id: 2, offsetSec: 1, trimStartSec: 0.4, trimEndSec: 1.4 }),
    ]);
    expect(a!.fadeOutSec).toBeCloseTo(0.2);
    expect(a!.fadeOutCurve).toBe('equalPower');
    expect(b!.offsetSec).toBeCloseTo(0.8);
    expect(b!.trimStartSec).toBeCloseTo(0.2);
    expect(b!.fadeInSec).toBeCloseTo(0.2);
    expect(b!.fadeInCurve).toBe('equalPower');
  });

  it('keeps a longer user fade on the overlapping edge', () => {
    const [a] = projectClipCrossfades([
      draft({ id: 1, offsetSec: 0, fadeOutSec: 0.5, crossfadeToNextSec: 0.2 }),
      draft({ id: 2, offsetSec: 1, trimStartSec: 0.4, trimEndSec: 1.4 }),
    ]);
    expect(a!.fadeOutSec).toBeCloseTo(0.5);
  });

  it('rewrites warped B so the pulled head stays in the map and the timeline end does not move', () => {
    const warp = [
      { fileStartSec: 2, fileEndSec: 4, ratio: 0.5, localOffsetSec: 0 },
      { fileStartSec: 4, fileEndSec: 6, ratio: 1.5, localOffsetSec: 1 },
    ];
    const bIn = draft({
      id: 2,
      offsetSec: 4,
      trimStartSec: 2,
      trimEndSec: 6,
      warpSegments: warp,
    });
    const endBefore = bIn.offsetSec + 4;
    const [, b] = projectClipCrossfades([
      draft({ id: 1, offsetSec: 0, trimEndSec: 4, crossfadeToNextSec: 0.5 }),
      bIn,
    ]);
    expect(b!.offsetSec).toBeCloseTo(3.5);
    expect(b!.trimStartSec).toBeCloseTo(1.5);
    expect(b!.warpSegments).toEqual([
      { fileStartSec: 1.5, fileEndSec: 2, ratio: 1, localOffsetSec: 0 },
      { fileStartSec: 2, fileEndSec: 4, ratio: 0.5, localOffsetSec: 0.5 },
      { fileStartSec: 4, fileEndSec: 6, ratio: 1.5, localOffsetSec: 1.5 },
    ]);
    const last = b!.warpSegments![b!.warpSegments!.length - 1]!;
    const endAfter = b!.offsetSec + last.localOffsetSec + (last.fileEndSec - last.fileStartSec) * last.ratio;
    expect(endAfter).toBeCloseTo(endBefore);
    expect(warp[0]!.localOffsetSec).toBe(0);
  });

  it('measures warped-B headroom with stretchRatio, same as native clipStretchRatio', () => {
    const [, b] = projectClipCrossfades([
      draft({ id: 1, offsetSec: 0, trimEndSec: 2, crossfadeToNextSec: 0.5 }),
      draft({
        id: 2,
        offsetSec: 2,
        trimStartSec: 1,
        trimEndSec: 3,
        stretchRatio: 2,
        warpSegments: [
          { fileStartSec: 1, fileEndSec: 2, ratio: 1, localOffsetSec: 0 },
          { fileStartSec: 2, fileEndSec: 3, ratio: 3, localOffsetSec: 1 },
        ],
      }),
    ]);
    expect(b!.offsetSec).toBeCloseTo(1.5);
    expect(b!.trimStartSec).toBeCloseTo(0.75);
    expect(b!.warpSegments![0]).toEqual({
      fileStartSec: 0.75,
      fileEndSec: 1,
      ratio: 2,
      localOffsetSec: 0,
    });
  });
});
