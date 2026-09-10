import { describe, expect, it } from 'vitest';
import {
  activitySig,
  holdPeak,
  jackFromOutputs,
  loudestJack,
  meterRefresh,
  METER_SLEEP_AFTER_MS,
  silentJack,
  type NodeActivity,
} from '../src/activity';

describe('activity jacks', () => {
  it('resolves cv from an audio tap and the reverse', () => {
    const audio = { ...silentJack(), peak: 0.6, mean: 0.6 };
    expect(jackFromOutputs({ audio }, 'cv').peak).toBe(0.6);
    expect(jackFromOutputs({ cv: audio }, 'audio').peak).toBe(0.6);
    expect(jackFromOutputs({ cv: audio }, 'cv').peak).toBe(0.6);
  });

  it('picks the loudest jack on a node', () => {
    const activity: NodeActivity = {
      outputs: { audio: { ...silentJack(), peak: 0.1 } },
      inputs: { cutoff: { ...silentJack(), peak: 0.8, mean: 0.8 } },
    };
    expect(loudestJack(activity)?.peak).toBe(0.8);
  });

  it('treats tiny peak jitter as the same meter frame', () => {
    const a: NodeActivity = { outputs: { audio: { ...silentJack(), peak: 0.41 } }, inputs: {} };
    const b: NodeActivity = { outputs: { audio: { ...silentJack(), peak: 0.42 } }, inputs: {} };
    expect(activitySig(a)).toBe(activitySig(b));
  });

  it('holds a peak so a short analyser window does not drop to zero on the next read', () => {
    expect(holdPeak(0.6, 0.05, 0.016)).toBeGreaterThan(0.5);
    expect(holdPeak(0.6, 0.9, 0.016)).toBe(0.9);
  });

  it('wakes the meter on audible peaks and sleeps after a quiet stretch', () => {
    expect(meterRefresh({ fast: false, peak: 0.005, quietMs: 0, dtMs: 250 })).toEqual({
      fast: false,
      quietMs: 250,
    });
    expect(meterRefresh({ fast: false, peak: 0.2, quietMs: 800, dtMs: 250 })).toEqual({
      fast: true,
      quietMs: 0,
    });
    expect(meterRefresh({ fast: true, peak: 0.03, quietMs: 0, dtMs: 16 })).toEqual({
      fast: true,
      quietMs: 0,
    });
    expect(
      meterRefresh({ fast: true, peak: 0.005, quietMs: METER_SLEEP_AFTER_MS - 32, dtMs: 16 }),
    ).toEqual({ fast: true, quietMs: METER_SLEEP_AFTER_MS - 16 });
    expect(
      meterRefresh({ fast: true, peak: 0.005, quietMs: METER_SLEEP_AFTER_MS, dtMs: 16 }),
    ).toEqual({ fast: false, quietMs: METER_SLEEP_AFTER_MS + 16 });
  });
});
