import { describe, expect, it } from 'vitest';
import { AudioScene } from '../../src/AudioScene';
import { Clip } from '../../src/graph/Clip';
import { Time } from '../../src/Time';
import { AutomationLane } from '../../src/automation/AutomationLane';
import { Easing } from '../../src/automation/Easing';
import { NAMED_POSITIONS } from '../../src/spatial/positions';
import { cartesianToSpherical, sphericalToCartesian } from '../../src/spatial/spherical';
import {
  closestNamedPositionByY,
  foaGainsFromPoint,
  foaGainsFromSpherical,
  FOA_W,
  recoverYFromRMS,
  stereoPanFromY,
} from '../../src/spatial/foa';
import { distanceAttenuation, DISTANCE_MODELS, spatialUpdateHz } from '../../src/spatial/distance';
import { parseSpatialMeta } from '../../src/spatial/meta';
import { encodeAmbisonics } from '../../src/spatial/encode';
import { SpatialSource } from '../../src/spatial/SpatialSource';
import { SpatialListener } from '../../src/spatial/SpatialListener';

describe('named positions', () => {
  it('places named presets on the expected axes', () => {
    expect(NAMED_POSITIONS.center).toEqual({ x: 0, y: 0, z: -1 });
    expect(NAMED_POSITIONS['front-left']).toEqual({ x: -0.7, y: 0, z: -0.7 });
    expect(NAMED_POSITIONS['side-right']).toEqual({ x: 1, y: 0, z: 0 });
    expect(NAMED_POSITIONS.above).toEqual({ x: 0, y: 1, z: -0.3 });
  });
});

describe('spherical', () => {
  it('0° is front (-z) and 90° is right (+x)', () => {
    const front = sphericalToCartesian(0, 0, 1);
    expect(front.x).toBeCloseTo(0);
    expect(front.z).toBeCloseTo(-1);
    const right = sphericalToCartesian(90, 0, 1);
    expect(right.x).toBeCloseTo(1);
    expect(right.z).toBeCloseTo(0);
  });

  it('round-trips the named presets', () => {
    for (const point of Object.values(NAMED_POSITIONS)) {
      const sph = cartesianToSpherical(point);
      const back = sphericalToCartesian(sph.azDeg, sph.elDeg, sph.distance);
      expect(back.x).toBeCloseTo(point.x, 5);
      expect(back.y).toBeCloseTo(point.y, 5);
      expect(back.z).toBeCloseTo(point.z, 5);
    }
  });
});

describe('FOA ACN/SN3D', () => {
  it('puts energy on X for a front source and on -Y for side-left', () => {
    const front = foaGainsFromSpherical(0, 0);
    expect(front.w).toBeCloseTo(FOA_W);
    expect(front.x).toBeCloseTo(1);
    expect(front.y).toBeCloseTo(0);
    expect(front.z).toBeCloseTo(0);

    const left = foaGainsFromPoint(NAMED_POSITIONS['side-left']);
    expect(left.y).toBeCloseTo(-1);
    expect(left.x).toBeCloseTo(0);
  });

  it('global is W only', () => {
    const g = foaGainsFromPoint(null);
    expect(g.w).toBeCloseTo(FOA_W);
    expect(g.y).toBe(0);
    expect(g.x).toBe(0);
  });

  it('inverts the Swift stereo fallback from L/R RMS', () => {
    const y = foaGainsFromPoint(NAMED_POSITIONS['front-left']).y;
    const pan = stereoPanFromY(y);
    const recovered = recoverYFromRMS(pan.l, pan.r);
    expect(recovered).toBeCloseTo(y, 5);
    expect(closestNamedPositionByY(recovered)).toBe('front-left');
  });
});

describe('distance', () => {
  it('preview inverse model is 1 at ref and 0.25 at max', () => {
    expect(distanceAttenuation(1, DISTANCE_MODELS.preview)).toBeCloseTo(1);
    expect(distanceAttenuation(4, DISTANCE_MODELS.preview)).toBeCloseTo(0.25);
  });

  it('tiers update rate by distance', () => {
    expect(spatialUpdateHz(1)).toBe(60);
    expect(spatialUpdateHz(8)).toBe(15);
    expect(spatialUpdateHz(40)).toBe(5);
  });
});

describe('SpatialSource / scene.spatial', () => {
  it('setNamed copies the preset and position.set is the spec API', () => {
    const source = new SpatialSource({ named: 'front-left' });
    expect(source.position.x).toBeCloseTo(-0.7);
    source.position.set(1.2, 0, -0.4);
    expect(source.position.z).toBeCloseTo(-0.4);
  });

  it('evaluateAt orbits azimuth from an AutomationLane', () => {
    const source = new SpatialSource({ named: 'center' });
    source.automate(
      'azimuth',
      new AutomationLane({
        shape: Easing.linear,
        from: 0,
        to: 90,
        range: { start: Time.seconds(0), end: Time.seconds(1) },
      }),
    );
    const mid = source.evaluateAt(0.5, { bpm: 120, ppqn: 24, beatsPerBar: 4 });
    expect(mid).not.toBeNull();
    expect(mid!.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(mid!.z).toBeCloseTo(-Math.SQRT1_2, 5);
  });

  it('listener yaw 90 looks +x', () => {
    const listener = new SpatialListener();
    listener.setYawPitch(90);
    expect(listener.forward.x).toBeCloseTo(1);
    expect(listener.forward.z).toBeCloseTo(0);
  });

  it('scene.spatial.export.toAmbisonics writes W/Y/Z/X plus stereo fallback', () => {
    const tone = new Float32Array(8).fill(1);
    const clip = new Clip({
      buffer: {
        sampleRate: 48000,
        length: 8,
        numberOfChannels: 1,
        getChannelData: () => tone,
      },
    });
    const scene = new AudioScene({ createContext: () => ({}) as never });
    scene.spatial.add(new SpatialSource(clip, { named: 'side-left', volume: 1 }));
    const { foa, stereo } = scene.spatial.export.toAmbisonics({ order: 1, sampleRate: 48000 });
    expect(foa.numberOfChannels).toBe(4);
    expect(foa.getChannelData(1)[0]).toBeCloseTo(-distanceAttenuation(1));
    expect(stereo.getChannelData(0)[0]).toBeGreaterThan(stereo.getChannelData(1)[0]!);
  });

  it('parses the sidecar JSON shape', () => {
    const meta = parseSpatialMeta('[{"trackIndex":0,"spatialPosition":"front-left","volume":0.8}]');
    expect(meta?.[0]?.spatialPosition).toBe('front-left');
  });
});

describe('encodeAmbisonics', () => {
  it('a center impulse lands on W and X, not Y', () => {
    const impulse = new Float32Array([1]);
    const { foa } = encodeAmbisonics([{ samples: impulse, position: NAMED_POSITIONS.center, volume: 1 }], {
      sampleRate: 48000,
    });
    expect(foa.getChannelData(0)[0]).toBeCloseTo(FOA_W);
    expect(foa.getChannelData(1)[0]).toBeCloseTo(0);
    expect(foa.getChannelData(3)[0]).toBeCloseTo(1);
  });
});
