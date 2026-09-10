import { describe, expect, it } from 'vitest';
import { Time } from '../../src/Time';
import { Track } from '../../src/graph/Track';
import { Easing } from '../../src/automation/Easing';
import { AutomationLane, mapDisplay127 } from '../../src/automation/AutomationLane';
import { evaluateNodeAutomation } from '../../src/automation/evaluate';
import { evaluateHostedAutomation } from '../../src/automation/hosted';

const CTX = { bpm: 120, ppqn: 24, beatsPerBar: 4 };

describe('Easing', () => {
  it('matches the app preset formulas at the anchors', () => {
    expect(Easing.linear(0)).toBe(0);
    expect(Easing.linear(1)).toBe(1);
    expect(Easing.exp(0)).toBe(0);
    expect(Easing.exp(1)).toBe(1);
    expect(Easing.log(0)).toBe(0);
    expect(Easing.log(1)).toBe(1);
    expect(Easing.sCurve(0.5)).toBeCloseTo(0.5);
    expect(Easing.swell(0)).toBeCloseTo(0);
    expect(Easing.swell(0.5)).toBeCloseTo(1);
    expect(Easing.swell(1)).toBeCloseTo(0);
  });

  it('exp stays below linear in the first half (slow start)', () => {
    expect(Easing.exp(0.5)).toBeLessThan(Easing.linear(0.5));
    expect(Easing.log(0.5)).toBeGreaterThan(Easing.linear(0.5));
  });
});

describe('AutomationLane', () => {
  const lane = new AutomationLane({
    shape: Easing.linear,
    from: 10,
    to: 20,
    range: { start: Time.seconds(1), end: Time.seconds(3) },
  });

  it('writes nothing before the range (no pre-roll slam)', () => {
    expect(lane.evaluate(0.5, CTX)).toBeUndefined();
  });

  it('interpolates inside the range', () => {
    expect(lane.evaluate(2, CTX)).toBeCloseTo(15);
  });

  it('holds the last value after the end by default', () => {
    expect(lane.evaluate(4, CTX)).toBeCloseTo(20);
  });

  it('stops writing after the end when hold is false', () => {
    const open = new AutomationLane({
      shape: Easing.linear,
      from: 0,
      to: 1,
      range: { start: Time.seconds(0), end: Time.seconds(1) },
      hold: false,
    });
    expect(open.evaluate(2, CTX)).toBeUndefined();
  });

  it('uses baked points when provided', () => {
    const points = new AutomationLane({
      range: { start: Time.seconds(0), end: Time.seconds(1) },
      points: [
        { t: 0, value: 0 },
        { t: 1, value: 127 },
      ],
    });
    expect(points.evaluate(0.5, CTX)).toBeCloseTo(63.5);
  });

  it('Track.automate exposes lanes that evaluate at a timeline instant', () => {
    const guitar = new Track({ name: 'guitar' });
    guitar.automate(
      'gain',
      new AutomationLane({
        shape: Easing.swell,
        from: 0,
        to: 1,
        range: { start: Time.seconds(0), end: Time.seconds(2) },
      }),
    );
    const mid = evaluateNodeAutomation(guitar, 1, CTX);
    expect(mid.gain).toBeCloseTo(1);
    expect(evaluateNodeAutomation(guitar, -1, CTX).gain).toBeUndefined();
  });
});

describe('evaluateHostedAutomation', () => {
  it('maps 0-127 through min/max and holds past the clip', () => {
    const writes = evaluateHostedAutomation(
      [
        {
          trackIndex: 2,
          clips: [
            {
              offsetMs: 1000,
              trimStartMs: 0,
              durationMs: 1000,
              automationLanes: [
                {
                  slotIndex: 0,
                  paramAddress: 15,
                  minValue: 20,
                  maxValue: 2000,
                  points: [
                    { time: 0, value: 0 },
                    { time: 1, value: 127 },
                  ],
                },
              ],
            },
          ],
        },
      ],
      2500,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.value).toBeCloseTo(2000);
    expect(mapDisplay127(0, 20, 2000)).toBe(20);
  });

  it('lets the later-starting clip govern the same target', () => {
    const writes = evaluateHostedAutomation(
      [
        {
          trackIndex: 0,
          clips: [
            {
              offsetMs: 0,
              trimStartMs: 0,
              durationMs: 4000,
              automationLanes: [
                {
                  slotIndex: 0,
                  paramAddress: 1,
                  minValue: 0,
                  maxValue: 1,
                  points: [{ time: 0, value: 0 }],
                },
              ],
            },
            {
              offsetMs: 1000,
              trimStartMs: 0,
              durationMs: 1000,
              automationLanes: [
                {
                  slotIndex: 0,
                  paramAddress: 1,
                  minValue: 0,
                  maxValue: 1,
                  points: [{ time: 0, value: 127 }],
                },
              ],
            },
          ],
        },
      ],
      1500,
    );
    expect(writes[0]!.value).toBeCloseTo(1);
  });

  it('maps virtual slot -1 gain to 0..2 and pitch to cents', () => {
    const writes = evaluateHostedAutomation(
      [
        {
          trackIndex: 1,
          clips: [
            {
              offsetMs: 0,
              trimStartMs: 0,
              durationMs: 1000,
              automationLanes: [
                {
                  slotIndex: -1,
                  paramAddress: 0,
                  minValue: 0,
                  maxValue: 1,
                  points: [{ time: 0, value: 127 }],
                },
                {
                  slotIndex: -1,
                  paramAddress: 1,
                  minValue: 0,
                  maxValue: 1,
                  points: [{ time: 0, value: 64 }],
                },
              ],
            },
          ],
        },
      ],
      0,
    );
    const gain = writes.find((w) => w.paramAddress === 0);
    const pitch = writes.find((w) => w.paramAddress === 1);
    expect(gain?.value).toBeCloseTo(2);
    expect(pitch?.value).toBeCloseTo(0);
  });
});
