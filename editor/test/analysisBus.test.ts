import { describe, expect, it } from 'vitest';
import { analysisOutletValue, deriveAnalysis, silentAnalysis } from '../src/analysisBus';

describe('deriveAnalysis', () => {
  it('uses the meter tap when a capture window is empty', () => {
    const view = deriveAnalysis(
      {
        time: 0,
        meters: { meter: { peak: 0.5, rms: 0.25 } },
        captures: {},
      },
      48000,
    );
    expect(view.peak).toBe(0.5);
    expect(view.rms).toBe(0.25);
    expect(view.hz).toBe(-1);
  });

  it('measures peak from a capture when no meter is present', () => {
    const wave = new Float32Array(8);
    wave[2] = -0.8;
    wave[3] = 0.4;
    const view = deriveAnalysis({ time: 0, meters: {}, captures: { scope: wave } }, 48000);
    expect(view.peak).toBeCloseTo(0.8);
    expect(view.wave).toBe(wave);
  });

  it('publishes note as MIDI and cv as 1V/oct', () => {
    const view = { ...silentAnalysis, hz: 440, midi: 69, cents: 0, peak: 0.4, rms: 0.2 };
    expect(analysisOutletValue(view, 'note')).toBe(69);
    expect(analysisOutletValue(view, 'cv')).toBeCloseTo(0, 8);
    expect(analysisOutletValue(view, 'hz')).toBe(440);
    expect(analysisOutletValue(view, 'gate')).toBe(1);
  });
});
