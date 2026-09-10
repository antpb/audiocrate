/**
 * In-place radix-2 complex FFT. `inverse` applies 1/N so
 * IFFT(FFT(x)) === x. Length must be a power of two.
 *
 * This is the substrate for the partitioned convolver. It is not a
 * public Material; graphs that need a spectrum go through `OfflineRenderer`
 * or a kernel, not this function.
 */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n !== im.length || n < 2 || (n & (n - 1)) !== 0) {
    throw new RangeError('fftRadix2: re/im must be the same power-of-two length >= 2');
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      const ti = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tr;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + half]! * wRe - im[i + k + half]! * wIm;
        const vIm = re[i + k + half]! * wIm + im[i + k + half]! * wRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextRe;
      }
    }
  }

  if (inverse) {
    const scale = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i]! *= scale;
      im[i]! *= scale;
    }
  }
}

/** Linear-magnitude spectrum of a block, length N/2+1. Pads/truncates to the next power of two. */
export function fftMagnitude(samples: ArrayLike<number>): Float32Array {
  let n = 2;
  while (n < samples.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const copy = Math.min(samples.length, n);
  for (let i = 0; i < copy; i++) re[i] = samples[i]!;
  fftRadix2(re, im, false);
  const bins = (n >> 1) + 1;
  const mag = new Float32Array(bins);
  for (let i = 0; i < bins; i++) mag[i] = Math.hypot(re[i]!, im[i]!);
  return mag;
}
