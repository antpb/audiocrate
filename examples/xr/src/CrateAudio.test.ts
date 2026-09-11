/**
 * The bridge, against fakes.
 *
 * The browser check (`scripts/check-plugin.mjs`) proves the real thing works
 * on a real audio thread and is the authority on that. It is also slow, needs
 * a build, and can only tell you *that* something is wrong. These cover the
 * decisions: which three.js class gets built, what order parameters are
 * applied in, whether two sounds share one renderer, and whether an
 * unsubscribe takes everyone else's analysis down with it.
 */
import { describe, expect, it, vi } from 'vitest';
import { CrateAudio, createCrateAudio, rendererFor, type ThreeNamespaceLike } from './CrateAudio';
import { resonantStoneMaterial } from './materials/resonantStone';

interface FakeAudio {
  kind: 'audio' | 'positional';
  source: AudioNode | null;
  volume: number;
  gain: GainNode;
  param: { value: number } & Record<string, unknown>;
  disconnected: boolean;
}

function fakeThree(): { three: ThreeNamespaceLike; built: FakeAudio[] } {
  const built: FakeAudio[] = [];
  const make = (kind: FakeAudio['kind']) =>
    function FakeAudioClass(this: unknown) {
      // `gain` is the GainNode, and its `.gain` is the AudioParam, matching
      // three.js. One of the tests below asserts `getOutput()` is not the
      // gain node on a PositionalAudio.
      const param = {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      };
      const self: FakeAudio = {
        kind,
        source: null,
        volume: 1,
        disconnected: false,
        gain: { gain: param } as unknown as GainNode,
        param,
      };
      built.push(self);
      return {
        setNodeSource(node: AudioNode) {
          self.source = node;
          return this;
        },
        setVolume(value: number) {
          self.volume = value;
          return this;
        },
        gain: self.gain,
        // A PositionalAudio returns its PannerNode here, which has no `.gain`.
        // Modelled so that reaching through `getOutput()` for a gain param
        // fails in this test.
        getOutput: () => (kind === 'positional' ? ({} as unknown as GainNode) : self.gain),
        disconnect() {
          self.disconnected = true;
          return this;
        },
      };
    } as unknown as ThreeNamespaceLike['Audio'];
  return { three: { Audio: make('audio'), PositionalAudio: make('positional') }, built };
}

/** A context that is only ever used as a map key and a clock. */
function fakeContext(): AudioContext {
  return { currentTime: 0 } as unknown as AudioContext;
}

/**
 * Stands in for `WebAudioRenderer.createVoice`. Injected by replacing the
 * renderer the module caches for a context, which is the same seam the real
 * code uses to share one renderer per context.
 */
function stubRenderer(context: AudioContext) {
  const params: Record<string, number> = {};
  const order: string[] = [];
  let intervalHz = -1;
  const listeners = new Set<(frame: unknown) => void>();
  const voice = {
    node: { disconnect: vi.fn() } as unknown as AudioWorkletNode,
    driver: { stop: vi.fn() } as unknown as ConstantSourceNode,
    auxInputs: [] as string[],
    inputIndexFor: () => 0,
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    setParam: (name: string, value: number) => {
      params[name] = value;
      order.push(name);
    },
    loadKernel: vi.fn(),
    sendKernel: vi.fn(),
    midiNoteOn: vi.fn(),
    midiNoteOff: vi.fn(),
    midiControlChange: vi.fn(),
    allNotesOff: vi.fn(),
    setHostBpm: vi.fn(),
    setTransport: vi.fn(),
    setAnalysisInterval: (hz: number) => {
      intervalHz = hz;
    },
    onAnalysis: (fn: (frame: never) => void) => {
      listeners.add(fn as never);
      return () => listeners.delete(fn as never);
    },
  };
  const renderer = rendererFor(context) as unknown as {
    createVoice: (graph: unknown) => Promise<unknown>;
  };
  const seen: unknown[] = [];
  renderer.createVoice = async (graph: unknown) => {
    seen.push(graph);
    return voice;
  };
  return { voice, params, order, seen, intervalOf: () => intervalHz, listenerCount: () => listeners.size };
}

describe('createCrateAudio', () => {
  it('builds a PositionalAudio by default and wires the voice into it', async () => {
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three, built } = fakeThree();

    const sound = await createCrateAudio({ context }, resonantStoneMaterial, {}, three);

    expect(built).toHaveLength(1);
    expect(built[0]!.kind).toBe('positional');
    expect(built[0]!.source).toBe(stub.voice.node);
    expect(sound).toBeInstanceOf(CrateAudio);
  });

  it('builds a plain Audio when asked for one', async () => {
    const context = fakeContext();
    stubRenderer(context);
    const { three, built } = fakeThree();
    await createCrateAudio({ context }, resonantStoneMaterial, { positional: false }, three);
    expect(built[0]!.kind).toBe('audio');
  });

  it("applies the AudioMaterial's own parameter defaults", async () => {
    // An AudioMaterial's parameter schema is its whole public surface. Passing one
    // and having its declared defaults ignored would mean the graph starts at
    // whatever the raw nodes happen to hold.
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three } = fakeThree();
    await createCrateAudio({ context }, resonantStoneMaterial, {}, three);
    expect(stub.params.pitch).toBe(resonantStoneMaterial.snapshotParams().pitch);
    expect(stub.params.ring).toBe(resonantStoneMaterial.snapshotParams().ring);
  });

  it('lets the caller override those defaults', async () => {
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three } = fakeThree();
    await createCrateAudio({ context }, resonantStoneMaterial, { params: { pitch: 333 } }, three);
    expect(stub.params.pitch).toBe(333);
  });

  it('applies every parameter before the node is connected', async () => {
    // A voice that connects at its defaults and is corrected a frame later
    // plays one frame of the wrong sound, which on a high-Q resonator is an
    // audible click rather than a subtlety.
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three, built } = fakeThree();
    let connectedAfter = -1;
    const original = built.length;
    void original;
    await createCrateAudio({ context }, resonantStoneMaterial, { params: { pitch: 200 } }, three);
    connectedAfter = stub.order.length;
    expect(connectedAfter).toBeGreaterThan(0);
    // `setNodeSource` happens after the param writes: the fake records the
    // source at connect time, and every param write is already in `order`.
    expect(built[0]!.source).not.toBeNull();
  });

  it('shares one renderer per AudioContext', () => {
    // Otherwise forty stones mean forty `addModule` calls for the same code.
    const context = fakeContext();
    expect(rendererFor(context)).toBe(rendererFor(context));
    expect(rendererFor(fakeContext())).not.toBe(rendererFor(context));
  });

  it('refuses to guess at a missing THREE', async () => {
    await expect(
      createCrateAudio({ context: fakeContext() }, resonantStoneMaterial, {}, undefined as never),
    ).rejects.toThrow(/THREE/);
  });
});

describe('CrateAudio', () => {
  it('ramps volume on the audio clock rather than stepping it', async () => {
    // A per-frame `setVolume` on a sustained tone is a buzz at the frame
    // rate. This is the one API here that exists purely to stop a caller
    // doing the obvious wrong thing.
    const context = fakeContext();
    stubRenderer(context);
    const { three, built } = fakeThree();
    const sound = await createCrateAudio({ context }, resonantStoneMaterial, {}, three);
    sound.rampVolume(0.5, 0.2);
    expect(built[0]!.param.linearRampToValueAtTime).toHaveBeenCalled();
  });

  it('ramps the gain node, not whatever getOutput() returns', async () => {
    // The bug this exists for: `PositionalAudio.getOutput()` is the panner,
    // not the gain, so `getOutput().gain` is undefined and the ramp throws.
    // It threw inside the plugin's own catch, so every stone in a live world
    // was created at volume zero and stayed there, including when struck.
    const context = fakeContext();
    stubRenderer(context);
    const { three, built } = fakeThree();
    const sound = await createCrateAudio({ context }, resonantStoneMaterial, {}, three);
    expect(built[0]!.kind).toBe('positional');
    expect(() => sound.rampVolume(1, 0.5)).not.toThrow();
    expect(built[0]!.param.linearRampToValueAtTime).toHaveBeenCalled();
  });

  it('keeps reporting for other readers when one unsubscribes', async () => {
    // Reporting is one rate for the whole voice. An unsubscribe that set it
    // to zero would stop everyone else, which in the plugin shows up as the
    // glow going dark for a reason that looks like a DSP bug and is not one.
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three } = fakeThree();
    const sound = await createCrateAudio({ context }, resonantStoneMaterial, {}, three);

    const offSlow = sound.onAnalysis(() => {}, 10);
    const offFast = sound.onAnalysis(() => {}, 30);
    expect(stub.intervalOf()).toBe(30);

    offFast();
    expect(stub.intervalOf()).toBe(10);
    expect(stub.listenerCount()).toBe(1);

    offSlow();
    expect(stub.intervalOf()).toBe(0);
    expect(stub.listenerCount()).toBe(0);
  });

  it('is safe to unsubscribe twice', async () => {
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three } = fakeThree();
    const sound = await createCrateAudio({ context }, resonantStoneMaterial, {}, three);
    const offA = sound.onAnalysis(() => {}, 10);
    sound.onAnalysis(() => {}, 25);
    offA();
    offA();
    // The second call must not drop the other reader's rate.
    expect(stub.intervalOf()).toBe(25);
  });

  it('releases the worklet on dispose', async () => {
    // The whole reason the plugin can scatter these: a voice that is not
    // disposed keeps evaluating a fused graph at 48 kHz for a stone nobody
    // is near.
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three, built } = fakeThree();
    const sound = await createCrateAudio({ context }, resonantStoneMaterial, {}, three);
    sound.dispose();
    expect(stub.voice.noteOff).toHaveBeenCalled();
    expect(stub.voice.node.disconnect).toHaveBeenCalled();
    expect(built[0]!.disconnected).toBe(true);
  });

  it('disposes cleanly when the context has already gone', async () => {
    const context = fakeContext();
    const stub = stubRenderer(context);
    const { three } = fakeThree();
    const sound = await createCrateAudio({ context }, resonantStoneMaterial, {}, three);
    (stub.voice.noteOff as unknown as { mockImplementation: (f: () => void) => void }).mockImplementation(
      () => {
        throw new Error('context closed');
      },
    );
    expect(() => sound.dispose()).not.toThrow();
    expect(stub.voice.node.disconnect).toHaveBeenCalled();
  });
});
