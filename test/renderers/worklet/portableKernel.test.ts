/**
 * The claim this file exists to check: a Material can ship DSP that a worklet
 * bundle was never built with.
 *
 * It drives the real `defineCrateVoiceProcessor` with the audio-thread
 * globals stubbed, so the code under test is the same code the browser runs,
 * including the fallback that decides a slot with no registered factory is
 * fine when the payload carries a module. The Playwright checks cover the
 * parts a Node test genuinely cannot (a real AudioWorkletNode); this covers
 * the part that is pure logic and would otherwise only be verified by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCrateVoiceProcessor } from '../../../src/renderers/worklet/defineVoiceProcessor';
import { buildWasmKernelFixture, WASM_KERNEL_FIXTURE_DESCRIPTOR } from '../../../src/testing/wasmKernelFixture';
import { fetchKernelBinary, clearKernelBinaryCache } from '../../../src/renderers/kernels/kernelBinary';
import { Material } from '../../../src/graph/Material';
import { kernel } from '../../../src/asl/builders';
import { tap } from '../../../src/asl/analysis';

const SR = 48000;

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  posted: Array<Record<string, unknown>>;
  postMessage(message: Record<string, unknown>): void;
}

function makePort(): FakePort {
  const port: FakePort = {
    onmessage: null,
    posted: [],
    postMessage(message) {
      port.posted.push(message);
    },
  };
  return port;
}

type ProcessorClass = new (options?: { processorOptions?: unknown }) => {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

const globals = globalThis as unknown as Record<string, unknown>;
let registered: ProcessorClass | null = null;

beforeEach(() => {
  registered = null;
  globals.sampleRate = SR;
  globals.currentTime = 0;
  globals.AudioWorkletProcessor = class {
    port = makePort();
  };
  globals.registerProcessor = (_name: string, cls: unknown) => {
    registered = cls as ProcessorClass;
  };
  clearKernelBinaryCache();
});

afterEach(() => {
  delete globals.sampleRate;
  delete globals.currentTime;
  delete globals.AudioWorkletProcessor;
  delete globals.registerProcessor;
});

/** Waits for the processor to acknowledge, so a test never races WASM instantiation. */
async function waitForKernel(port: FakePort, slot: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const message = port.posted.find(
      (m) => m.slot === slot && (m.type === 'kernelReady' || m.type === 'kernelError'),
    );
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`no kernelReady/kernelError for "${slot}"`);
}

/** A Material from a package crate core has never heard of. */
const acmeTape = new Material({
  name: 'Acme Tape',
  kind: 'acme.tape',
  params: {},
  graph: ({ input }) => kernel.seam('acme.tape.kernel', input),
});

describe('a portable kernel in a worklet built without it', () => {
  it('loads at an unregistered slot and processes real audio', async () => {
    // No kernels passed: this is crate's own worklet, ASL and the core
    // primitives only. Nobody compiled anything called "acme.tape.kernel".
    defineCrateVoiceProcessor('portable-test', {});
    const processor = new registered!({ processorOptions: { graph: acmeTape.graph } });

    processor.port.onmessage!({
      data: {
        type: 'loadKernel',
        slot: 'acme.tape.kernel',
        payload: {
          binary: buildWasmKernelFixture(),
          descriptor: WASM_KERNEL_FIXTURE_DESCRIPTOR,
          params: { gain: 0.5 },
        },
      },
    });

    const ready = await waitForKernel(processor.port, 'acme.tape.kernel');
    expect(ready.type).toBe('kernelReady');
    expect(ready.info).toMatchObject({ portable: true, name: 'fixture.gain' });

    const input = new Float32Array(128).fill(1);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    processor.process([[input, input]], [[outL, outR]]);

    expect(outL.every((sample) => Math.abs(sample - 0.5) < 1e-6)).toBe(true);
    // A seam graph stays mono, so the right channel is the mirror.
    expect(outR.every((sample) => Math.abs(sample - 0.5) < 1e-6)).toBe(true);
  });

  it('still refuses an unknown slot whose payload is not a portable kernel', async () => {
    defineCrateVoiceProcessor('portable-test', {});
    const processor = new registered!({ processorOptions: { graph: acmeTape.graph } });

    processor.port.onmessage!({
      data: { type: 'loadKernel', slot: 'acme.tape.kernel', payload: { namJson: '{}' } },
    });

    const answer = await waitForKernel(processor.port, 'acme.tape.kernel');
    expect(answer.type).toBe('kernelError');
    // The message has to say both halves, because "wrong worklet" and "wrong
    // payload" are different mistakes with the same symptom.
    expect(String(answer.message)).toMatch(/not a portable WASM kernel/);
  });

  it('passes params through to the module while it runs', async () => {
    defineCrateVoiceProcessor('portable-test', {});
    const processor = new registered!({ processorOptions: { graph: acmeTape.graph } });
    processor.port.onmessage!({
      data: {
        type: 'loadKernel',
        slot: 'acme.tape.kernel',
        payload: { binary: buildWasmKernelFixture(), descriptor: WASM_KERNEL_FIXTURE_DESCRIPTOR },
      },
    });
    await waitForKernel(processor.port, 'acme.tape.kernel');

    processor.port.onmessage!({ data: { type: 'setParam', name: 'gain', value: 0.25 } });
    const input = new Float32Array(128).fill(1);
    const out = new Float32Array(128);
    processor.process([[input]], [[out]]);
    expect(out.every((sample) => Math.abs(sample - 0.25) < 1e-6)).toBe(true);
  });
});

describe('fetching a kernel binary', () => {
  it('shares one request per URL across every voice that asks', async () => {
    const bytes = buildWasmKernelFixture();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }));

    const results = await Promise.all([
      fetchKernelBinary('/tape.wasm', { fetchImpl: fetchImpl as unknown as typeof fetch }),
      fetchKernelBinary('/tape.wasm', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ]);
    await fetchKernelBinary('/tape.wasm', { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe(results[1]);
  });

  it('does not poison the cache with a failed request', async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(
      fetchKernelBinary('/missing.wasm', { fetchImpl: failing as unknown as typeof fetch }),
    ).rejects.toThrow(/404/);

    const bytes = buildWasmKernelFixture();
    const working = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }));
    await expect(
      fetchKernelBinary('/missing.wasm', { fetchImpl: working as unknown as typeof fetch }),
    ).resolves.toBeInstanceOf(ArrayBuffer);
  });
});

describe('analysis frames from the worklet', () => {
  const metered = new Material({
    name: 'Metered',
    kind: 'metered.test',
    params: {},
    channels: 1,
    graph: ({ input }) => tap.capture(tap.meter(input, { id: 'level' }), { id: 'window', windowSize: 64 }),
  });

  function run(processor: { process(i: Float32Array[][], o: Float32Array[][]): boolean }, blocks: number): void {
    const input = new Float32Array(128).fill(0.5);
    for (let i = 0; i < blocks; i++) {
      globals.currentTime = (i * 128) / SR;
      processor.process([[input]], [[new Float32Array(128)]]);
    }
  }

  it('posts nothing until a host asks, however long it runs', () => {
    // The default has to be silence. A tap in a graph nobody reads costs its
    // own two operations and no message traffic at all.
    defineCrateVoiceProcessor('analysis-test', {});
    const processor = new registered!({ processorOptions: { graph: metered.graph } });
    run(processor, 200);
    expect(processor.port.posted.filter((m) => m.type === 'analysis')).toHaveLength(0);
  });

  it('posts meters and windows once asked', () => {
    defineCrateVoiceProcessor('analysis-test', {});
    const processor = new registered!({ processorOptions: { graph: metered.graph } });
    processor.port.onmessage!({ data: { type: 'setAnalysisInterval', hz: 30 } });
    run(processor, 40);

    const frames = processor.port.posted.filter((m) => m.type === 'analysis');
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0] as unknown as {
      meters: Record<string, { peak: number; rms: number }>;
      captures: Record<string, Float32Array>;
    };
    expect(first.meters.level!.peak).toBeCloseTo(0.5, 5);
    expect(first.meters.level!.rms).toBeCloseTo(0.5, 5);
    expect(first.captures.window).toHaveLength(64);
  });

  it('holds to the rate it was given rather than the block rate', () => {
    // 40 blocks at 128 frames is about 107 ms. At 30 Hz that is three or
    // four frames; at block rate it would be forty.
    defineCrateVoiceProcessor('analysis-test', {});
    const processor = new registered!({ processorOptions: { graph: metered.graph } });
    processor.port.onmessage!({ data: { type: 'setAnalysisInterval', hz: 30 } });
    run(processor, 40);
    const frames = processor.port.posted.filter((m) => m.type === 'analysis');
    expect(frames.length).toBeLessThanOrEqual(5);
  });

  it('stops when asked to stop', () => {
    defineCrateVoiceProcessor('analysis-test', {});
    const processor = new registered!({ processorOptions: { graph: metered.graph } });
    processor.port.onmessage!({ data: { type: 'setAnalysisInterval', hz: 60 } });
    run(processor, 20);
    const during = processor.port.posted.filter((m) => m.type === 'analysis').length;
    expect(during).toBeGreaterThan(0);

    processor.port.onmessage!({ data: { type: 'setAnalysisInterval', hz: 0 } });
    run(processor, 60);
    expect(processor.port.posted.filter((m) => m.type === 'analysis')).toHaveLength(during);
  });

  it('carries whatever a bound kernel reports from poll()', () => {
    let polls = 0;
    defineCrateVoiceProcessor('analysis-test', {
      'test.reporting': () => ({
        processSeam: (input: Float32Array, output: Float32Array) => output.set(input),
        poll: () => ({ polls: ++polls }),
      }),
    });
    const seamed = new Material({
      name: 'Seamed',
      kind: 'seamed.test',
      params: {},
      channels: 1,
      graph: ({ input }) => tap.meter(kernel.seam('test.reporting', input), { id: 'level' }),
    });
    const processor = new registered!({ processorOptions: { graph: seamed.graph } });
    processor.port.onmessage!({ data: { type: 'loadKernel', slot: 'test.reporting', payload: {} } });
    return waitForKernel(processor.port, 'test.reporting').then(() => {
      processor.port.onmessage!({ data: { type: 'setAnalysisInterval', hz: 30 } });
      run(processor, 40);
      const frames = processor.port.posted.filter((m) => m.type === 'analysis');
      expect((frames[0] as unknown as { kernels?: Record<string, unknown> }).kernels).toMatchObject({
        'test.reporting': { polls: 1 },
      });
      // Polled at the analysis rate, not once per block.
      expect(polls).toBeLessThanOrEqual(5);
    });
  });
});
