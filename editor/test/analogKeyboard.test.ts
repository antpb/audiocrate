import { describe, expect, it } from 'vitest';
import { AnalogKeyboard, lampsFromHeld, reconcileHeld, voltsFromMidi } from '../src/analogKeyboard';

describe('AnalogKeyboard', () => {
  it('is last-note priority with held CV after release', () => {
    const keys = new AnalogKeyboard();
    keys.press(60, 0.5);
    keys.press(64, 0.9);
    expect(keys.snapshot.note).toBe(64);
    expect(keys.snapshot.gate).toBe(1);
    expect(keys.snapshot.held).toEqual([60, 64]);
    keys.release(64);
    expect(keys.snapshot.note).toBe(60);
    expect(keys.snapshot.gate).toBe(1);
    keys.release(60);
    expect(keys.snapshot.gate).toBe(0);
    expect(keys.snapshot.note).toBe(60);
    expect(keys.snapshot.cv).toBe(voltsFromMidi(60));
  });

  it('treats A4 as 0V and C4 as -0.75V', () => {
    expect(voltsFromMidi(69)).toBe(0);
    expect(voltsFromMidi(60)).toBeCloseTo(-0.75);
    expect(voltsFromMidi(81)).toBe(1);
  });

  it('ignores a release that was never pressed', () => {
    const keys = new AnalogKeyboard();
    keys.release(60);
    expect(keys.snapshot.held).toEqual([]);
    expect(keys.snapshot.gate).toBe(0);
  });

  it('fills voice lamps from held notes and steals the oldest when full', () => {
    const lamps = lampsFromHeld([60, 64, 67, 71], 3);
    expect(lamps.map((lamp) => lamp.note)).toEqual([64, 67, 71]);
    expect(lamps.every((lamp) => lamp.held)).toBe(true);
  });

  it('sizes lamps from the wired Material, not the analog last-note', () => {
    const keys = new AnalogKeyboard();
    keys.setVoiceView({ polyphony: 8, steal: 'oldest', targetName: 'Oscillator' });
    keys.press(60, 0.5);
    keys.press(64, 0.9);
    expect(keys.snapshot.note).toBe(64);
    expect(keys.snapshot.held).toEqual([60, 64]);
    expect(keys.snapshot.polyphony).toBe(8);
    expect(keys.snapshot.targetName).toBe('Oscillator');
    expect(keys.snapshot.lamps).toHaveLength(8);
    expect(keys.snapshot.lamps.filter((lamp) => lamp.held).map((lamp) => lamp.note)).toEqual([60, 64]);
  });

  it('drops a note that lifted during an awaited Play and re-strikes one still down', () => {
    const physical = new Set([64]);
    expect(reconcileHeld([60, 64], physical)).toEqual({ drop: [60], strike: [64] });
    expect(reconcileHeld([60], new Set())).toEqual({ drop: [60], strike: [] });
  });
});
