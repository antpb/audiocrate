/**
 * ITU-R BS.1770-4 momentary loudness over a block. K-weighting plus mean
 * square, reported in LUFS. A block utility: the 400 ms momentary window
 * is not a per-sample ASL node.
 */
export function momentaryLufs(samples: ArrayLike<number>, sampleRate: number): number {
  if (samples.length === 0) return -70;
  const weighted = kWeight(samples, sampleRate);
  let mean = 0;
  for (let i = 0; i < weighted.length; i++) mean += weighted[i]! * weighted[i]!;
  mean /= weighted.length;
  if (mean <= 1e-12) return -70;
  return -0.691 + 10 * Math.log10(mean);
}

function kWeight(samples: ArrayLike<number>, sampleRate: number): Float64Array {
  const out = new Float64Array(samples.length);
  const hp = highpass38(sampleRate);
  const shelf = highShelf1500(sampleRate);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let s1 = 0;
  let s2 = 0;
  let t1 = 0;
  let t2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const hpY =
      (hp.b0 / hp.a0) * x +
      (hp.b1 / hp.a0) * x1 +
      (hp.b2 / hp.a0) * x2 -
      (hp.a1 / hp.a0) * y1 -
      (hp.a2 / hp.a0) * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = hpY;
    const shY =
      (shelf.b0 / shelf.a0) * hpY +
      (shelf.b1 / shelf.a0) * s1 +
      (shelf.b2 / shelf.a0) * s2 -
      (shelf.a1 / shelf.a0) * t1 -
      (shelf.a2 / shelf.a0) * t2;
    s2 = s1;
    s1 = hpY;
    t2 = t1;
    t1 = shY;
    out[i] = shY;
  }
  return out;
}

function highpass38(sampleRate: number): { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number } {
  const f0 = 38.13;
  const q = 0.5;
  const w = (2 * Math.PI * f0) / sampleRate;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const alpha = sinw / (2 * q);
  return {
    b0: (1 + cosw) / 2,
    b1: -(1 + cosw),
    b2: (1 + cosw) / 2,
    a0: 1 + alpha,
    a1: -2 * cosw,
    a2: 1 - alpha,
  };
}

function highShelf1500(sampleRate: number): { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number } {
  const f0 = 1500;
  const gainDb = 4;
  const a = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / sampleRate;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const alpha = (sinw / 2) * Math.sqrt((a + 1 / a) * (1 / 0.707 - 1) + 2);
  const sqA = Math.sqrt(a);
  return {
    b0: a * (a + 1 + (a - 1) * cosw + 2 * sqA * alpha),
    b1: -2 * a * (a - 1 + (a + 1) * cosw),
    b2: a * (a + 1 + (a - 1) * cosw - 2 * sqA * alpha),
    a0: a + 1 - (a - 1) * cosw + 2 * sqA * alpha,
    a1: 2 * (a - 1 - (a + 1) * cosw),
    a2: a + 1 - (a - 1) * cosw - 2 * sqA * alpha,
  };
}
