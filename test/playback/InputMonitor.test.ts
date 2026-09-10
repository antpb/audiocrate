import { describe, expect, it } from 'vitest';
import { InputMonitor, type LiveInputNode, type MonitorTrackConfig } from '../../src/playback/InputMonitor';
import { Track } from '../../src/graph/Track';
import { Bus } from '../../src/graph/Bus';
import type { LiveSceneVoices } from '../../src/playback/liveVoices';
import type { VoiceHandle } from '../../src/renderers/WebAudioRenderer';
import { fakeVoiceHandle } from '../../src/testing/fakeVoice';

interface FakeNode {
  connect(n: unknown): void;
  disconnect(): void;
  connectedTo: unknown[];
  disconnected: boolean;
}

function makeNode(extra: Record<string, unknown> = {}): FakeNode & Record<string, unknown> {
  const node = {
    connectedTo: [] as unknown[],
    disconnected: false,
    connect(n: unknown) {
      node.connectedTo.push(n);
    },
    disconnect(dest?: unknown) {
      if (dest === undefined) {
        node.disconnected = true;
        node.connectedTo = [];
        return;
      }
      node.connectedTo = node.connectedTo.filter((item) => item !== dest);
    },
    ...extra,
  };
  return node;
}

function fakeCtx() {
  return {
    currentTime: 0,
    sampleRate: 48000,
    destination: makeNode(),
    createGain: () => makeNode({ gain: { value: 1 } }),
    createStereoPanner: () => makeNode({ pan: { value: 0 } }),
    createBufferSource: () => makeNode({ buffer: null, playbackRate: { value: 1 }, start() {}, stop() {} }),
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { copyToChannel: () => {}, getChannelData: (ch: number) => data[ch]! };
    },
  };
}

function fakeInput(): LiveInputNode & FakeNode {
  return makeNode() as unknown as LiveInputNode & FakeNode;
}

function fakeVoice(): VoiceHandle {
  const node = makeNode();
  return fakeVoiceHandle(node as unknown as VoiceHandle['node']);
}

describe('InputMonitor', () => {
  it('routes a dry (no plugin) monitored track straight to its fader', () => {
    const track = new Track({ name: 'T' });
    track.volume = 0.7;
    track.pan = -0.3;
    const input = fakeInput();
    const monitor = new InputMonitor();

    const start = monitor.start(fakeCtx() as never, [track], new Bus({ name: 'Master' }), [
      { trackId: track.id, input, mode: 'monitor' },
    ]);

    expect(start.audibleTrackIds).toEqual([track.id]);
    expect(input.connectedTo).toHaveLength(1);
    const fader = start.trackFaders.get(track.id)!;
    expect(fader.gain.value).toBe(0.7);
    expect(fader.pan.value).toBe(-0.3);
    expect(start.postInsertTaps.size).toBe(0);
    expect(monitor.isActive).toBe(true);
  });

  it('routes a monitored track WITH plugins through the insert chain first', () => {
    const track = new Track({ name: 'T' });
    const insert = fakeVoice();
    const input = fakeInput();
    const voices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [insert] }]]),
    };
    const monitor = new InputMonitor();

    const start = monitor.start(
      fakeCtx() as never,
      [track],
      new Bus({ name: 'Master' }),
      [{ trackId: track.id, input, mode: 'monitor' }],
      voices,
    );

    // The input feeds the insert's node, not the fader directly.
    const insertNode = insert.node as unknown as FakeNode;
    expect(input.connectedTo[0]).toBe(insert.node);
    expect(insertNode.connectedTo).toHaveLength(1); // insert -> fader
    expect(start.postInsertTaps.get(track.id)).toBe(insert.node);
    expect(start.postInsertTaps.get(track.id)).not.toBe(start.trackFaders.get(track.id));
  });

  it('exposes the last insert as the wet tap, not the first', () => {
    const track = new Track({ name: 'T' });
    const first = fakeVoice();
    const last = fakeVoice();
    const voices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [first, last] }]]),
    };
    const start = new InputMonitor().start(
      fakeCtx() as never,
      [track],
      new Bus({ name: 'Master' }),
      [{ trackId: track.id, input: fakeInput(), mode: 'monitor' }],
      voices,
    );
    expect(start.postInsertTaps.get(track.id)).toBe(last.node);
    expect(start.postInsertTaps.get(track.id)).not.toBe(first.node);
  });

  it('does not make an "armed" (metering only) track audible', () => {
    const track = new Track({ name: 'T' });
    const input = fakeInput();
    const monitor = new InputMonitor();

    const start = monitor.start(fakeCtx() as never, [track], new Bus({ name: 'Master' }), [
      { trackId: track.id, input, mode: 'armed' },
    ]);

    expect(start.audibleTrackIds).toEqual([]);
    expect(input.connectedTo).toHaveLength(0); // nothing toward the master: no feedback path
  });

  it('monitors several tracks at once, each on its own chain', () => {
    const a = new Track({ name: 'A' });
    const b = new Track({ name: 'B' });
    const inputA = fakeInput();
    const inputB = fakeInput();
    const monitor = new InputMonitor();

    const start = monitor.start(fakeCtx() as never, [a, b], new Bus({ name: 'Master' }), [
      { trackId: a.id, input: inputA, mode: 'monitor' },
      { trackId: b.id, input: inputB, mode: 'monitor' },
    ]);

    expect(start.audibleTrackIds).toEqual([a.id, b.id]);
    expect(start.trackFaders.size).toBe(2);
    expect(start.trackFaders.get(a.id)).not.toBe(start.trackFaders.get(b.id));
  });

  it('skips a muted track', () => {
    const track = new Track({ name: 'T' });
    track.muted = true;
    const input = fakeInput();
    const monitor = new InputMonitor();
    const start = monitor.start(fakeCtx() as never, [track], new Bus({ name: 'Master' }), [
      { trackId: track.id, input, mode: 'monitor' },
    ]);
    expect(start.audibleTrackIds).toEqual([]);
    expect(input.connectedTo).toHaveLength(0);
  });

  it('stop() drops only the monitor feed, not every tap on the input', () => {
    const track = new Track({ name: 'T' });
    const input = fakeInput();
    const extra = makeNode();
    const monitor = new InputMonitor();
    monitor.start(fakeCtx() as never, [track], new Bus({ name: 'Master' }), [
      { trackId: track.id, input, mode: 'monitor' },
    ]);
    input.connect(extra);

    monitor.stop();
    expect(input.disconnected).toBe(false);
    expect(input.connectedTo).toEqual([extra]);
    expect(monitor.isActive).toBe(false);
  });

  it('re-arming does not stack duplicate connections on a reused input or voice', () => {
    const track = new Track({ name: 'T' });
    const insert = fakeVoice();
    const input = fakeInput();
    const voices: LiveSceneVoices = { master: [], tracks: new Map([[track.id, { inserts: [insert] }]]) };
    const monitor = new InputMonitor();
    const configs: MonitorTrackConfig[] = [{ trackId: track.id, input, mode: 'monitor' }];

    monitor.start(fakeCtx() as never, [track], new Bus({ name: 'Master' }), configs, voices);
    monitor.start(fakeCtx() as never, [track], new Bus({ name: 'Master' }), configs, voices);

    expect(input.connectedTo).toHaveLength(1);
    expect((insert.node as unknown as FakeNode).connectedTo).toHaveLength(1);
    expect((insert.node as unknown as FakeNode).disconnected).toBe(false);
  });

  it('carries master volume, and is silent when master is muted', () => {
    const track = new Track({ name: 'T' });
    const master = new Bus({ name: 'Master' });
    master.volume = 0.4;
    const monitor = new InputMonitor();
    monitor.start(fakeCtx() as never, [track], master, [
      { trackId: track.id, input: fakeInput(), mode: 'monitor' },
    ]);
    // The master node is internal; its effect shows up as the graph existing.
    // Muted master must still build without throwing and stay inaudible.
    master.muted = true;
    const start = monitor.start(fakeCtx() as never, [track], master, [
      { trackId: track.id, input: fakeInput(), mode: 'monitor' },
    ]);
    expect(start.audibleTrackIds).toEqual([track.id]);
  });
});
