/**
 * The pose mappings, as pure functions.
 *
 * These have not been checked against a physical phone in this repo, which is
 * exactly why the sign conventions are pinned here against the W3C
 * definitions rather than left to be discovered by someone holding a device
 * and wondering which way is wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  poseFromDeviceOrientation,
  poseFromDrag,
  wrapDegrees,
  availableHeadTrackerSources,
} from '../../src/spatial/HeadTracker';

describe('wrapDegrees', () => {
  it('leaves small angles alone', () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(90)).toBe(90);
    expect(wrapDegrees(-90)).toBe(-90);
  });

  it('takes the short way round rather than the long one', () => {
    // The bug this exists to prevent: turning a few degrees past north
    // reading as a 350 degree lurch.
    expect(wrapDegrees(350)).toBe(-10);
    expect(wrapDegrees(-350)).toBe(10);
    expect(wrapDegrees(540)).toBe(180);
  });

  it('is stable at the boundary rather than flipping sign', () => {
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-180)).toBe(180);
  });
});

describe('poseFromDeviceOrientation', () => {
  const reference = { alpha: 40, beta: 90 };

  it('is centred at the reference attitude', () => {
    expect(poseFromDeviceOrientation({ alpha: 40, beta: 90 }, reference)).toEqual({
      yawDeg: 0,
      pitchDeg: 0,
    });
  });

  it('turning right gives positive yaw', () => {
    // `alpha` increases counter-clockwise seen from above, so turning the
    // device right makes it fall. Yaw is positive to the right. If this
    // inverts, the room turns the wrong way and everything else still looks
    // correct, which is the hardest kind of bug to spot by ear.
    expect(poseFromDeviceOrientation({ alpha: 10, beta: 90 }, reference).yawDeg).toBe(30);
    expect(poseFromDeviceOrientation({ alpha: 70, beta: 90 }, reference).yawDeg).toBe(-30);
  });

  it('crosses north without lurching', () => {
    const pose = poseFromDeviceOrientation({ alpha: 350, beta: 90 }, { alpha: 10, beta: 90 });
    expect(pose.yawDeg).toBe(20);
  });

  it('takes pitch relative to how the device is being held', () => {
    // Someone holding a phone at a comfortable angle should be looking level,
    // not permanently down.
    expect(poseFromDeviceOrientation({ alpha: 40, beta: 60 }, { alpha: 40, beta: 60 }).pitchDeg).toBe(0);
    expect(poseFromDeviceOrientation({ alpha: 40, beta: 110 }, reference).pitchDeg).toBe(20);
  });

  it('clamps pitch to the poles', () => {
    expect(poseFromDeviceOrientation({ alpha: 40, beta: -90 }, reference).pitchDeg).toBe(-90);
    expect(poseFromDeviceOrientation({ alpha: 40, beta: 179 }, reference).pitchDeg).toBe(89);
  });

  it('holds the last attitude when the sensor reports nothing', () => {
    // Absent readings must not read as "facing exactly north", which would
    // snap the field round on a dropped sample.
    expect(poseFromDeviceOrientation({ alpha: null, beta: null }, reference)).toEqual({
      yawDeg: 0,
      pitchDeg: 0,
    });
  });

  it('inverts yaw on request, without touching pitch', () => {
    const normal = poseFromDeviceOrientation({ alpha: 10, beta: 110 }, reference);
    const flipped = poseFromDeviceOrientation({ alpha: 10, beta: 110 }, reference, { invertYaw: true });
    expect(flipped.yawDeg).toBe(-normal.yawDeg);
    expect(flipped.pitchDeg).toBe(normal.pitchDeg);
  });
});

describe('poseFromDrag', () => {
  it('does nothing at rest', () => {
    expect(poseFromDrag(0, 0)).toEqual({ yawDeg: 0, pitchDeg: 0 });
  });

  it('drags right to look right, and down to look down', () => {
    expect(poseFromDrag(100, 0).yawDeg).toBeGreaterThan(0);
    expect(poseFromDrag(0, 100).pitchDeg).toBeLessThan(0);
    expect(poseFromDrag(0, -100).pitchDeg).toBeGreaterThan(0);
  });

  it('scales with the sensitivity given', () => {
    expect(poseFromDrag(100, 0, 0.5).yawDeg).toBe(50);
    expect(poseFromDrag(100, 0, 1).yawDeg).toBe(100);
  });

  it('wraps a long horizontal drag instead of running past a full turn', () => {
    expect(poseFromDrag(1000, 0, 0.4).yawDeg).toBe(40);
  });

  it('clamps pitch rather than tipping over the pole', () => {
    expect(poseFromDrag(0, 1000, 0.4).pitchDeg).toBe(-90);
    expect(poseFromDrag(0, -1000, 0.4).pitchDeg).toBe(90);
  });
});

describe('availableHeadTrackerSources', () => {
  it('reports nothing in Node, where there is no window', () => {
    // The honest answer for a headless render, and what stops a host
    // offering a control that could never work.
    expect(availableHeadTrackerSources()).toEqual([]);
  });
});
