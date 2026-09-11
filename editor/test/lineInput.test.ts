import { describe, expect, it } from 'vitest';
import { lineMonitorOn } from '../src/lineInput';

describe('line monitor', () => {
  it('is off unless the node opts in', () => {
    expect(lineMonitorOn(undefined)).toBe(false);
    expect(lineMonitorOn({})).toBe(false);
    expect(lineMonitorOn({ monitor: 0 })).toBe(false);
    expect(lineMonitorOn({ monitor: false })).toBe(false);
    expect(lineMonitorOn({ monitor: 1 })).toBe(true);
    expect(lineMonitorOn({ monitor: true })).toBe(true);
  });
});
