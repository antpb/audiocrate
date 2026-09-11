import { describe, expect, it } from 'vitest';
import { AudioScene } from '../../src/AudioScene';
import { Track } from '../../src/graph/Track';
import { Bus } from '../../src/graph/Bus';
import { Clip, type AudioBufferLike } from '../../src/graph/Clip';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { uniform } from '../../src/asl/builders';
import { Time } from '../../src/Time';

function fakeBuffer(length = 1000, sampleRate = 48000): AudioBufferLike {
  const data = new Float32Array(length);
  return {
    sampleRate,
    length,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

function fakeMaterial(name: string): AudioMaterial {
  return new AudioMaterial({ name, graph: () => uniform(0) });
}

describe('AudioNode3 (via Track/Bus)', () => {
  it('Track and Bus both expose pan and an empty materials chain by default', () => {
    const track = new Track({ name: 'Guitar' });
    const bus = new Bus({ name: 'Reverb Send' });
    expect(track.pan).toBe(0);
    expect(bus.pan).toBe(0);
    expect(track.materials.list).toEqual([]);
    expect(bus.materials.list).toEqual([]);
  });

  it('gives every instance a unique id, regardless of subclass', () => {
    const a = new Track();
    const b = new Bus();
    expect(a.id).not.toBe(b.id);
  });

  it('materials chain preserves insertion order and supports removal', () => {
    const track = new Track();
    const amp = fakeMaterial('amp');
    const eq = fakeMaterial('eq');
    track.materials.add(amp);
    track.materials.add(eq);
    expect([...track.materials].map((m) => m.name)).toEqual(['amp', 'eq']);

    expect(track.materials.remove(amp)).toBe(true);
    expect([...track.materials].map((m) => m.name)).toEqual(['eq']);
    expect(track.materials.remove(amp)).toBe(false); // already removed
  });

  it('pan is a plain settable property, matching the spec example', () => {
    const guitar = new Track({ name: 'Guitar' });
    guitar.pan = 0.3;
    expect(guitar.pan).toBe(0.3);
  });
});

describe('Track clips', () => {
  it('addClip stores the clip at a structured Time, retrievable in insertion order', () => {
    const track = new Track({ name: 'Guitar' });
    const clip = new Clip({ buffer: fakeBuffer() });
    track.addClip(clip, { at: Time.bars(2, 1, 0) });

    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]!.clip).toBe(clip);
    expect(track.clips[0]!.at.equals(Time.bars(2, 1, 0))).toBe(true);
  });

  it('supports multiple clips and removal by reference', () => {
    const track = new Track();
    const clipA = new Clip({ buffer: fakeBuffer(), name: 'A' });
    const clipB = new Clip({ buffer: fakeBuffer(), name: 'B' });
    track.addClip(clipA, { at: Time.bars(1, 1, 0) });
    track.addClip(clipB, { at: Time.bars(3, 1, 0) });

    expect(track.clips.map((s) => s.clip.name)).toEqual(['A', 'B']);
    expect(track.removeClip(clipA)).toBe(true);
    expect(track.clips.map((s) => s.clip.name)).toEqual(['B']);
    expect(track.removeClip(clipA)).toBe(false);
  });
});

describe('AudioScene track graph', () => {
  it('addTrack returns the same instance and lists it under scene.tracks', () => {
    const scene = new AudioScene({ createContext: () => fakeContext() });
    const track = new Track({ name: 'Guitar' });
    const returned = scene.addTrack(track);

    expect(returned).toBe(track);
    expect(scene.tracks).toEqual([track]);
  });

  it('exposes a master Bus that materials can be added to', () => {
    const scene = new AudioScene({ createContext: () => fakeContext() });
    expect(scene.master).toBeInstanceOf(Bus);
    scene.master.materials.add(fakeMaterial('dynEQ'));
    expect(scene.master.materials.list.map((m) => m.name)).toEqual(['dynEQ']);
  });

  it('removeTrack removes a previously-added track', () => {
    const scene = new AudioScene({ createContext: () => fakeContext() });
    const track = scene.addTrack(new Track());
    expect(scene.removeTrack(track)).toBe(true);
    expect(scene.tracks).toEqual([]);
  });

  it('two scenes never share tracks or a master bus', () => {
    const sceneA = new AudioScene({ createContext: () => fakeContext() });
    const sceneB = new AudioScene({ createContext: () => fakeContext() });
    sceneA.addTrack(new Track({ name: 'Guitar' }));

    expect(sceneA.tracks).toHaveLength(1);
    expect(sceneB.tracks).toHaveLength(0);
    expect(sceneA.master).not.toBe(sceneB.master);
  });
});

function fakeContext() {
  return {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running' as const,
    async resume() {},
    async close() {},
  };
}
