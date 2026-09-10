import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDiff, writeGoldenFixture } from '../../src/testing/renderDiff';
import type { OfflineRenderResult } from '../../src/renderers/OfflineRenderer';

const SR = 48000;

function sine(n: number, freq: number, phaseOffsetSamples = 0): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * (i + phaseOffsetSamples)) / SR));
}

describe('renderDiff', () => {
  let dir: string;
  let goldenPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crate-render-diff-'));
    goldenPath = join(dir, 'fixture.golden.wav');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves with passed: true when the render exactly matches the golden fixture', async () => {
    const golden: OfflineRenderResult = { samples: sine(256, 1000), sampleRate: SR };
    await writeGoldenFixture(goldenPath, golden);

    const result = await renderDiff(golden, goldenPath, { tolerance: 0.001 });
    expect(result.passed).toBe(true);
    expect(result.maxSampleDiff).toBe(0);
    expect(result.sampleRateMismatch).toBe(false);
    expect(result.lengthMismatch).toBe(false);
  });

  it('throws with a diagnostic message when the render exceeds sample tolerance', async () => {
    const golden: OfflineRenderResult = { samples: sine(256, 1000), sampleRate: SR };
    await writeGoldenFixture(goldenPath, golden);

    const rendered: OfflineRenderResult = { samples: sine(256, 1000).map((s) => s + 0.5), sampleRate: SR };
    await expect(renderDiff(rendered, goldenPath, { tolerance: 0.001 })).rejects.toThrow(/max sample diff/);
  });

  it('reports sample rate and length mismatches as failures', async () => {
    const golden: OfflineRenderResult = { samples: sine(256, 1000), sampleRate: SR };
    await writeGoldenFixture(goldenPath, golden);

    const rendered: OfflineRenderResult = { samples: sine(128, 1000), sampleRate: 44100 };
    await expect(renderDiff(rendered, goldenPath)).rejects.toThrow(/sample rate mismatch.*length mismatch/s);
  });

  it('spectral tolerance tolerates a 1-sample phase shift that sample-domain tolerance would reject', async () => {
    // 480 samples at 1000Hz/48kHz is an exact 10 periods, avoiding DFT
    // spectral leakage from an unaligned window so the shift's only real
    // effect on the magnitude spectrum is the boundary discontinuity it
    // introduces, not leakage noise.
    const golden: OfflineRenderResult = { samples: sine(480, 1000), sampleRate: SR };
    await writeGoldenFixture(goldenPath, golden);
    const shifted: OfflineRenderResult = { samples: sine(480, 1000, 1), sampleRate: SR };

    // fails a tight sample-domain check...
    await expect(renderDiff(shifted, goldenPath, { tolerance: 0.001 })).rejects.toThrow(/max sample diff/);

    // ...but passes once sample tolerance is loosened and spectral shape is compared instead
    const result = await renderDiff(shifted, goldenPath, { tolerance: 10, spectralTolerance: 1 });
    expect(result.passed).toBe(true);
    expect(result.maxSpectralDiffDb).toBeLessThan(1);
  });
});
