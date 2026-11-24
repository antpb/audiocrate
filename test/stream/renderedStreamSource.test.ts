/** Playing rendered chunks as one stream, and asking for more. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderedStreamSource, combineStreamSources } from '../../src/stream/RenderedStreamSource';

const SR = 1000;

function fakeContext() {
  const started: Array<{ at: number; offset: number; length: number }> = [];
  const ctx = {
    currentTime: 0,
    sampleRate: SR,
    createGain: () => ({ connect() {}, disconnect() {} }),
    createBuffer: (_c: number, length: number) => ({ length, copyToChannel() {} }),
    createBufferSource: () => {
      const node = {
        buffer: null as { length: number } | null,
        connect() {},
        disconnect() {},
        start(at: number, offset: number) {
          started.push({ at, offset, length: node.buffer!.length });
        },
        stop() {},
      };
      return node;
    },
  };
  return { ctx, started };
}

const chunk = (frames: number) => [new Float32Array(frames), new Float32Array(frames)] as const;

describe('RenderedStreamSource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays contiguous chunks back to back from the offset asked for', () => {
    const { ctx, started } = fakeContext();
    const source = new RenderedStreamSource({ durationSec: 10, sampleRate: SR });
    source.outputFor(ctx);
    source.push(0, ...chunk(500));
    source.push(0.5, ...chunk(500));
    expect(source.bufferedAheadSec(0.2)).toBeCloseTo(0.8);
    source.start(5, 0.2);
    expect(started).toEqual([
      { at: 5, offset: 0.2, length: 500 },
      { at: 5.3, offset: 0, length: 500 },
    ]);
    source.push(1, ...chunk(500)); // arrives while playing
    expect(started[2]).toEqual({ at: 5.8, offset: 0, length: 500 });
  });

  it('ignores a chunk that does not continue the span (a stale render)', () => {
    const source = new RenderedStreamSource({ durationSec: 10, sampleRate: SR });
    source.push(0, ...chunk(500));
    source.push(3, ...chunk(500));
    expect(source.renderedUntilSec).toBeCloseTo(0.5);
  });

  it('asks for a render from a position outside the span, then reports a stall until it comes', () => {
    const { ctx } = fakeContext();
    const need: number[] = [];
    const stalls: boolean[] = [];
    const source = new RenderedStreamSource({ durationSec: 10, sampleRate: SR, onNeed: (from) => need.push(from) });
    source.outputFor(ctx);
    source.onStall((s) => stalls.push(s));
    source.push(0, ...chunk(500));
    source.start(0, 4); // a seek past what exists
    expect(need).toEqual([4]);
    vi.advanceTimersByTime(60);
    expect(stalls).toEqual([true]);
    source.push(4, ...chunk(500));
    expect(stalls).toEqual([true, false]);
    expect(source.bufferedAheadSec(4)).toBeCloseTo(0.5);
  });

  it('combines sources for one buffering guard: least buffered, stalled while any is', () => {
    const a = new RenderedStreamSource({ durationSec: 10, sampleRate: SR });
    const b = new RenderedStreamSource({ durationSec: 10, sampleRate: SR });
    a.push(0, ...chunk(2000));
    b.push(0, ...chunk(500));
    const both = combineStreamSources([a, b]);
    expect(both.bufferedAheadSec(0)).toBeCloseTo(0.5);
    expect(both.durationSec).toBe(10);
  });
});
