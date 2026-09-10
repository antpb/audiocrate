import { describe, expect, it, vi } from 'vitest';
import { AudioScene } from '../src/AudioScene';
import { SceneNotStartedError } from '../src/errors';
import { Track } from '../src/graph/Track';
import type { AudioContextLike } from '../src/AudioContextLike';

function createFakeContext(initialState: AudioContextLike['state'] = 'suspended') {
  const fake = {
    currentTime: 0,
    sampleRate: 48000,
    state: initialState,
    resumeCalls: 0,
    closeCalls: 0,
    async resume() {
      fake.resumeCalls += 1;
      fake.state = 'running';
    },
    async close() {
      fake.closeCalls += 1;
      fake.state = 'closed';
    },
  };
  return fake;
}

describe('AudioScene lifecycle', () => {
  it('throws SceneNotStartedError reading currentTime before start()', () => {
    const scene = new AudioScene({ createContext: () => createFakeContext() });
    expect(() => scene.currentTime).toThrow(SceneNotStartedError);
  });

  it('throws SceneNotStartedError calling transport.play() before start()', () => {
    const scene = new AudioScene({ createContext: () => createFakeContext() });
    expect(() => scene.transport.play()).toThrow(SceneNotStartedError);
  });

  it('throws SceneNotStartedError reading audioContext before start()', () => {
    const scene = new AudioScene({ createContext: () => createFakeContext() });
    expect(() => scene.audioContext).toThrow(SceneNotStartedError);
  });

  it('exposes the exact injected context instance once started, for a renderer to attach to', async () => {
    const ctx = createFakeContext('running');
    const scene = new AudioScene({ createContext: () => ctx });
    await scene.start();
    expect(scene.audioContext).toBe(ctx);
  });

  it('resolves start() and allows transport.play() afterward', async () => {
    const scene = new AudioScene({ createContext: () => createFakeContext() });
    await scene.start();
    expect(scene.isStarted).toBe(true);
    expect(() => scene.transport.play()).not.toThrow();
    expect(scene.transport.state).toBe('playing');
  });

  it('resumes a suspended context but does not resume an already-running one', async () => {
    const running = createFakeContext('running');
    const scene = new AudioScene({ createContext: () => running });
    await scene.start();
    expect(running.resumeCalls).toBe(0);

    const suspended = createFakeContext('suspended');
    const scene2 = new AudioScene({ createContext: () => suspended });
    await scene2.start();
    expect(suspended.resumeCalls).toBe(1);
  });

  it('is idempotent: concurrent start() calls only create one context', async () => {
    const factory = vi.fn(() => createFakeContext());
    const scene = new AudioScene({ createContext: factory });
    await Promise.all([scene.start(), scene.start(), scene.start()]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('exposes the real context currentTime once started', async () => {
    const ctx = createFakeContext('running');
    ctx.currentTime = 4.2;
    const scene = new AudioScene({ createContext: () => ctx });
    await scene.start();
    expect(scene.currentTime).toBe(4.2);
  });

  it('dispose() closes the context and returns the scene to an unstarted state', async () => {
    const ctx = createFakeContext('running');
    const scene = new AudioScene({ createContext: () => ctx });
    await scene.start();
    await scene.dispose();
    expect(ctx.closeCalls).toBe(1);
    expect(scene.isStarted).toBe(false);
    expect(() => scene.currentTime).toThrow(SceneNotStartedError);
  });
});

describe('two scenes never share state', () => {
  it('have independent transports', async () => {
    const sceneA = new AudioScene({ createContext: () => createFakeContext('running') });
    const sceneB = new AudioScene({ createContext: () => createFakeContext('running') });
    await Promise.all([sceneA.start(), sceneB.start()]);

    sceneA.transport.bpm = 140;
    sceneA.transport.play();

    expect(sceneB.transport.bpm).toBe(120);
    expect(sceneB.transport.state).toBe('stopped');
  });

  it('have independent spatial graphs', () => {
    const sceneA = new AudioScene({ createContext: () => createFakeContext() });
    const sceneB = new AudioScene({ createContext: () => createFakeContext() });
    sceneA.spatial.listener.setYawPitch(90);
    expect(sceneB.spatial.listener.forward.z).toBeCloseTo(-1);
    expect(sceneA.spatial).not.toBe(sceneB.spatial);
  });

  it('have independent contexts, so disposing one never affects the other', async () => {
    const ctxA = createFakeContext('running');
    const ctxB = createFakeContext('running');
    const sceneA = new AudioScene({ createContext: () => ctxA });
    const sceneB = new AudioScene({ createContext: () => ctxB });
    await Promise.all([sceneA.start(), sceneB.start()]);

    await sceneA.dispose();

    expect(sceneA.isStarted).toBe(false);
    expect(sceneB.isStarted).toBe(true);
    expect(ctxB.closeCalls).toBe(0);
  });
});

describe('AudioScene monitoring', () => {
  it('throws SceneNotStartedError starting monitoring before start()', () => {
    const scene = new AudioScene({ createContext: () => createFakeContext() });
    expect(() => scene.startMonitoring([])).toThrow(SceneNotStartedError);
  });

  it('stops playback when monitoring starts, matching native mutual exclusion', async () => {
    const scene = new AudioScene({ createContext: () => createFakeContext('running') });
    await scene.start();
    scene.transport.play();
    expect(scene.transport.state).toBe('playing');

    scene.startMonitoring([]);
    expect(scene.transport.state).toBe('stopped');
  });

  it('stops monitoring when playback starts, the other direction of the same rule', async () => {
    const scene = new AudioScene({ createContext: () => createFakeContext('running') });
    await scene.start();
    const input = { connect: () => {}, disconnect: () => {} };
    const track = scene.addTrack(new Track({ name: 'T' }));
    scene.startMonitoring([{ trackId: track.id, input, mode: 'monitor' }]);
    expect(scene.monitor.isActive).toBe(true);

    scene.transport.play();
    expect(scene.monitor.isActive).toBe(false);
  });

  it('lastInsertNode is null until live voices exist', () => {
    const scene = new AudioScene({ createContext: () => createFakeContext() });
    expect(scene.lastInsertNode(1)).toBeNull();
  });

  it('dispose() tears monitoring down too', async () => {
    const scene = new AudioScene({ createContext: () => createFakeContext('running') });
    await scene.start();
    const track = scene.addTrack(new Track({ name: 'T' }));
    scene.startMonitoring([{ trackId: track.id, input: { connect: () => {}, disconnect: () => {} }, mode: 'monitor' }]);
    await scene.dispose();
    expect(scene.monitor.isActive).toBe(false);
  });
});
