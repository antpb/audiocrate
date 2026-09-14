/**
 * `dsp/CascadeFilter.h`, line for line. The master bus runs it at order 3:
 * one bilinear 1-pole into one RBJ cookbook biquad.
 */

export const CASCADE_LOWPASS = 0;
export const CASCADE_HIGHPASS = 1;
export const CASCADE_BANDPASS = 2;

interface BqState {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  s1: number;
  s2: number;
}

function newBq(): BqState {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, s1: 0, s2: 0 };
}

/** Direct-form II transposed. */
function tick(bq: BqState, x: number): number {
  const y = bq.b0 * x + bq.s1;
  bq.s1 = bq.b1 * x - bq.a1 * y + bq.s2;
  bq.s2 = bq.b2 * x - bq.a2 * y;
  return y;
}

export class CascadeFilter {
  private type = CASCADE_LOWPASS;
  private order = 2;
  private cutoff = 2000;
  private q = 0;
  private sampleRate = 48000;

  private lp1 = newBq();
  private hp1 = newBq();
  private lpBq = [newBq(), newBq()];
  private hpBq = [newBq(), newBq()];

  init(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.reset();
    this.update();
  }

  reset(): void {
    this.lp1 = newBq();
    this.hp1 = newBq();
    this.lpBq = [newBq(), newBq()];
    this.hpBq = [newBq(), newBq()];
  }

  setType(type: number): void {
    this.type = Math.min(2, Math.max(0, type));
  }

  /** 1 = 6 dB/oct, 2 = 12, 3 = 18, 4 = 24. */
  setOrder(order: number): void {
    const next = Math.min(4, Math.max(1, order));
    if (next === this.order) return;
    this.order = next;
    this.reset();
    this.update();
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
    if (this.type === CASCADE_HIGHPASS) return this.runHP(input);
    if (this.type === CASCADE_BANDPASS) return this.runHP(this.runLP(input));
    return this.runLP(input);
  }

  private runLP(x: number): number {
    let y = x;
    if (this.order === 1 || this.order === 3) y = tick(this.lp1, y);
    if (this.order >= 2) y = tick(this.lpBq[0]!, y);
    if (this.order === 4) y = tick(this.lpBq[1]!, y);
    return y;
  }

  private runHP(x: number): number {
    let y = x;
    if (this.order === 1 || this.order === 3) y = tick(this.hp1, y);
    if (this.order >= 2) y = tick(this.hpBq[0]!, y);
    if (this.order === 4) y = tick(this.hpBq[1]!, y);
    return y;
  }

  private update(): void {
    const fs = this.sampleRate > 0 ? this.sampleRate : 48000;
    const fc = this.cutoff;

    const baseQ = 0.7071;
    const userQ = baseQ + this.q * 1.8;
    const q1 = 0.5412 + this.q * (userQ - 0.5412);
    const q2 = 1.3066 + this.q * (userQ - 1.3066);

    const w = (Math.PI * fc) / fs;
    const t = Math.tan(w);
    const a = (1 - t) / (1 + t);
    this.lp1.b0 = this.lp1.b1 = (1 - a) * 0.5;
    this.lp1.b2 = 0;
    this.lp1.a1 = -a;
    this.lp1.a2 = 0;
    this.hp1.b0 = (1 + a) * 0.5;
    this.hp1.b1 = -this.hp1.b0;
    this.hp1.b2 = 0;
    this.hp1.a1 = -a;
    this.hp1.a2 = 0;

    calcLP(this.lpBq[0]!, fc, q1, fs);
    calcHP(this.hpBq[0]!, fc, q1, fs);
    calcLP(this.lpBq[1]!, fc, q2, fs);
    calcHP(this.hpBq[1]!, fc, q2, fs);
  }
}

function calcLP(bq: BqState, fc: number, q: number, fs: number): void {
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  bq.b0 = ((1 - cosw) * 0.5) / a0;
  bq.b1 = (1 - cosw) / a0;
  bq.b2 = bq.b0;
  bq.a1 = (-2 * cosw) / a0;
  bq.a2 = (1 - alpha) / a0;
}

function calcHP(bq: BqState, fc: number, q: number, fs: number): void {
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  bq.b0 = ((1 + cosw) * 0.5) / a0;
  bq.b1 = -(1 + cosw) / a0;
  bq.b2 = bq.b0;
  bq.a1 = (-2 * cosw) / a0;
  bq.a2 = (1 - alpha) / a0;
}
