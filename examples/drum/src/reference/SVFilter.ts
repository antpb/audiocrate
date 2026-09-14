/** `dsp/SVFilter.h`, line for line. Cytomic topology, per-pad low-pass. */

export const SVF_LOWPASS = 0;
export const SVF_HIGHPASS = 1;
export const SVF_BANDPASS = 2;

/** Pade [3/3], the approximation the AUv3 uses instead of tanf on the audio thread. */
export function fastTan(x: number): number {
  const x2 = x * x;
  return (x * (15 - x2)) / (15 - 6 * x2);
}

export class SVFilter {
  private type = SVF_LOWPASS;
  private cutoff = 8000;
  private q = 0;
  private sampleRate = 48000;

  private k = 2;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;

  private ic1eq = 0;
  private ic2eq = 0;

  init(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.ic1eq = this.ic2eq = 0;
    this.update();
  }

  reset(): void {
    this.ic1eq = this.ic2eq = 0;
  }

  setType(type: number): void {
    this.type = Math.min(2, Math.max(0, type));
  }

  setCutoff(hz: number): void {
    if (hz === this.cutoff) return;
    this.cutoff = Math.min(20000, Math.max(20, hz));
    this.update();
  }

  setResonance(q: number): void {
    if (q === this.q) return;
    this.q = Math.min(1, Math.max(0, q));
    this.update();
  }

  process(input: number): number {
    const v3 = input - this.ic2eq;
    const v1 = this.a1 * this.ic1eq + this.a2 * v3;
    const v2 = this.ic2eq + this.a2 * this.ic1eq + this.a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;

    if (this.type === SVF_HIGHPASS) return input - this.k * v1 - v2;
    if (this.type === SVF_BANDPASS) return v1;
    return v2;
  }

  private update(): void {
    const w = (Math.PI * this.cutoff) / this.sampleRate;
    const g = fastTan(w);
    // K is damping: 2 is no resonance, 0.1 is nearly self-oscillating.
    this.k = 2 - this.q * 1.9;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
}
