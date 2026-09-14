/**
 * The claim that lets the master bus skip convolution entirely.
 *
 * `synthesizeDefaultMasterIR` builds its impulse response by running a unit
 * impulse through an 18 dB/oct low-pass at 17 kHz. Convolving with a filter's
 * impulse response is running the filter, so the wet path can be the filter
 * again rather than a convolver, and nothing in ASL has to grow an FFT.
 *
 * This checks the identity rather than assuming it. A truncated impulse
 * response is not literally the filter, and 1024 samples is where the AU cuts
 * it off.
 */
import { describe, expect, it } from 'vitest';
import { CascadeFilter, CASCADE_LOWPASS } from './CascadeFilter';
import { DEFAULT_IR_CUTOFF, DEFAULT_IR_RESONANCE, defaultMasterIR } from './DrumKernel';

const SR = 48000;

describe('the character IR', () => {
  it('is the 17 kHz cascade, so convolving with it is running that filter', () => {
    const ir = defaultMasterIR(SR);
    expect(ir).toHaveLength(1024);

    const frames = 1024;
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / SR;
      input[i] = Math.sin(2 * Math.PI * 440 * t) * 0.5 + Math.sin(2 * Math.PI * 9000 * t) * 0.4;
    }

    const convolved = new Float32Array(frames);
    for (let n = 0; n < frames; n++) {
      let sum = 0;
      for (let k = 0; k < ir.length && k <= n; k++) sum += ir[k]! * input[n - k]!;
      convolved[n] = sum;
    }

    const filter = new CascadeFilter();
    filter.init(SR);
    filter.setOrder(3);
    filter.setType(CASCADE_LOWPASS);
    filter.setCutoff(DEFAULT_IR_CUTOFF);
    filter.setResonance(DEFAULT_IR_RESONANCE);
    const filtered = new Float32Array(frames);
    for (let i = 0; i < frames; i++) filtered[i] = filter.process(input[i]!);

    let worst = 0;
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(convolved[i]! - filtered[i]!));
    expect(worst).toBeLessThan(1e-6);
  });

  it('decays long before the AU truncates it, which is why the identity holds', () => {
    const ir = defaultMasterIR(SR);
    let tail = 0;
    for (let i = 64; i < ir.length; i++) tail = Math.max(tail, Math.abs(ir[i]!));
    expect(tail).toBeLessThan(1e-6);
  });
});
