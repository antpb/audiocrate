/**
 * YIN (CMNDF) monophonic pitch. A block utility, not a per-sample ASL node:
 * the difference function needs a window.
 */
export function yinPitch(
  samples: ArrayLike<number>,
  sampleRate: number,
  opts: { minHz?: number; maxHz?: number; threshold?: number } = {},
): number {
  const minHz = opts.minHz ?? 50;
  const maxHz = opts.maxHz ?? 2000;
  const threshold = opts.threshold ?? 0.1;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(sampleRate / minHz), Math.floor(samples.length / 2) - 1);
  if (tauMax <= tauMin + 2) return -1;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i]! * samples[i]!;
  if (energy < 1e-10) return -1;

  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    const last = samples.length - tau;
    for (let i = 0; i < last; i++) {
      const delta = samples[i]! - samples[i + tau]!;
      sum += delta * delta;
    }
    d[tau] = sum;
  }

  const cmndf = new Float64Array(tauMax + 1);
  cmndf[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau]!;
    cmndf[tau] = running > 0 ? (d[tau]! * tau) / running : 1;
  }

  let bestTau = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmndf[tau]! < threshold) {
      while (tau + 1 <= tauMax && cmndf[tau + 1]! < cmndf[tau]!) tau += 1;
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) return -1;

  const y0 = cmndf[bestTau - 1] ?? cmndf[bestTau]!;
  const y1 = cmndf[bestTau]!;
  const y2 = cmndf[bestTau + 1] ?? cmndf[bestTau]!;
  // Parabolic vertex through the three points around the minimum. The
  // numerator is (y2 - y0) rather than (y0 - y2) because `denom` is written
  // as 2*y1 - y2 - y0, which is the negative of the usual y0 - 2*y1 + y2.
  // Getting that sign backwards moves the estimate the wrong way by up to
  // half a sample, which reads as a consistent few cents sharp at every
  // pitch whose period is not a whole number of samples.
  const denom = 2 * y1 - y2 - y0;
  const shift = Math.abs(denom) > 1e-12 ? (y2 - y0) / (2 * denom) : 0;
  return sampleRate / (bestTau + shift);
}
