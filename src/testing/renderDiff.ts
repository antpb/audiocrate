import { readFile, writeFile } from 'node:fs/promises';
import { decodeWavFloat32, encodeWavFloat32 } from './wav';
import type { OfflineRenderResult } from '../renderers/OfflineRenderer';

export interface RenderDiffOptions {
  /** Max allowed per-sample absolute difference. Default 0.001. */
  tolerance?: number;
  /**
   * Max allowed per-bin magnitude-spectrum difference, in dB, for cases
   * where a resampler makes an exact-sample diff too strict. Omit to skip
   * spectral comparison entirely.
   */
  spectralTolerance?: number;
}

export interface RenderDiffResult {
  passed: boolean;
  maxSampleDiff: number;
  sampleRateMismatch: boolean;
  lengthMismatch: boolean;
  maxSpectralDiffDb?: number;
  failures: string[];
}

const DB_FLOOR = -180;

/**
 * Naive O(n^2) DFT magnitude spectrum in dB. Fine for the short (sub-second)
 * fixtures a render-diff test suite actually needs; not meant for anything
 * real-time. Exact sample-domain diffs are too strict once a resampler is
 * anywhere in the signal path, but the frequency content should still match.
 */
function magnitudeSpectrumDb(samples: Float32Array): Float64Array {
  const n = samples.length;
  const half = Math.floor(n / 2) + 1;
  const mags = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      re += samples[t]! * Math.cos(angle);
      im += samples[t]! * Math.sin(angle);
    }
    const mag = Math.sqrt(re * re + im * im) / n;
    mags[k] = mag > 0 ? Math.max(20 * Math.log10(mag), DB_FLOOR) : DB_FLOOR;
  }
  return mags;
}

/**
 * Compares a render against a golden fixture and throws
 * (with every diagnostic in the message) on the first mismatch, so a test
 * can be a single `await renderDiff(...)` line with no separate assertion.
 * Resolves with the full diagnostic result when it passes, for callers that
 * want the numbers rather than just a boolean.
 */
export async function renderDiff(
  rendered: OfflineRenderResult,
  goldenPath: string,
  options: RenderDiffOptions = {},
): Promise<RenderDiffResult> {
  const tolerance = options.tolerance ?? 0.001;
  const golden = decodeWavFloat32(await readFile(goldenPath));

  const failures: string[] = [];

  const sampleRateMismatch = golden.sampleRate !== rendered.sampleRate;
  if (sampleRateMismatch) {
    failures.push(`sample rate mismatch: rendered ${rendered.sampleRate}Hz vs golden ${golden.sampleRate}Hz`);
  }

  const lengthMismatch = golden.samples.length !== rendered.samples.length;
  if (lengthMismatch) {
    failures.push(`length mismatch: rendered ${rendered.samples.length} samples vs golden ${golden.samples.length} samples`);
  }

  const compareLength = Math.min(golden.samples.length, rendered.samples.length);
  let maxSampleDiff = 0;
  for (let i = 0; i < compareLength; i++) {
    const diff = Math.abs(rendered.samples[i]! - golden.samples[i]!);
    if (diff > maxSampleDiff) maxSampleDiff = diff;
  }
  if (maxSampleDiff > tolerance) {
    failures.push(`max sample diff ${maxSampleDiff.toFixed(6)} exceeds tolerance ${tolerance}`);
  }

  let maxSpectralDiffDb: number | undefined;
  if (options.spectralTolerance != null && compareLength > 0) {
    const renderedSpectrum = magnitudeSpectrumDb(rendered.samples.subarray(0, compareLength));
    const goldenSpectrum = magnitudeSpectrumDb(golden.samples.subarray(0, compareLength));
    maxSpectralDiffDb = 0;
    for (let k = 0; k < renderedSpectrum.length; k++) {
      const diff = Math.abs(renderedSpectrum[k]! - goldenSpectrum[k]!);
      if (diff > maxSpectralDiffDb) maxSpectralDiffDb = diff;
    }
    if (maxSpectralDiffDb > options.spectralTolerance) {
      failures.push(`max spectral diff ${maxSpectralDiffDb.toFixed(2)}dB exceeds tolerance ${options.spectralTolerance}dB`);
    }
  }

  const result: RenderDiffResult = {
    passed: failures.length === 0,
    maxSampleDiff,
    sampleRateMismatch,
    lengthMismatch,
    maxSpectralDiffDb,
    failures,
  };

  if (!result.passed) {
    throw new Error(`renderDiff against "${goldenPath}" failed: ${failures.join('; ')}`);
  }

  return result;
}

/** Writes a render as a golden fixture. Not part of the spec's public API surface; a fixture-authoring convenience. */
export async function writeGoldenFixture(path: string, rendered: OfflineRenderResult): Promise<void> {
  await writeFile(path, encodeWavFloat32(rendered));
}
