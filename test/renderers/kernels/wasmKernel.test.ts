/**
 * The portable kernel, against a real `WebAssembly.instantiate` of a real
 * module. Nothing is mocked: if these pass, a third party who emits the same
 * shape has a working kernel.
 */
import { describe, expect, it } from 'vitest';
import { wasmKernelFactory, isWasmKernelPayload, CRATE_KERNEL_ABI_VERSION } from '../../../src/renderers/kernels/wasmKernel';
import type { WasmKernelDescriptor } from '../../../src/renderers/kernels/wasmKernel';
import { buildWasmKernelFixture, WASM_KERNEL_FIXTURE_DESCRIPTOR } from '../../../src/testing/wasmKernelFixture';
import { AudioMaterial } from '../../../src/graph/AudioMaterial';
import { kernel } from '../../../src/asl/builders';
import { compileVoice } from '../../../src/asl/compile';

const SR = 48000;
const descriptor = WASM_KERNEL_FIXTURE_DESCRIPTOR as unknown as WasmKernelDescriptor;

const load = (overrides: Partial<WasmKernelDescriptor> = {}, params?: Record<string, number>) =>
  wasmKernelFactory(SR, {
    binary: buildWasmKernelFixture(),
    descriptor: { ...descriptor, ...overrides },
    params,
  });

describe('portable WASM kernel', () => {
  it('instantiates a freestanding module and processes a block', async () => {
    const processor = await load();
    const input = new Float32Array([1, -0.5, 0.25, 0]);
    const output = new Float32Array(4);
    processor.processSeam!(input, output);
    // Gain starts at unity, so the module is a passthrough until told otherwise.
    expect([...output]).toEqual([1, -0.5, 0.25, 0]);
  });

  it('pushes declared params in by their integer id', async () => {
    const processor = await load();
    processor.applyParams!({ gain: 0.5, somethingElse: 99 });
    const output = new Float32Array(3);
    processor.processSeam!(new Float32Array([1, 1, 1]), output);
    expect([...output]).toEqual([0.5, 0.5, 0.5]);
  });

  it('applies the payload params before the first block', async () => {
    const processor = await load({}, { gain: 0.25 });
    const output = new Float32Array(2);
    processor.processSeam!(new Float32Array([1, 1]), output);
    expect([...output]).toEqual([0.25, 0.25]);
  });

  it('chunks a block longer than the kernel was initialised for', async () => {
    // A caller may hand crate a bigger buffer than 128 frames. Truncating
    // would drop audio silently, which is the worst possible failure here.
    const processor = await load({ maxFrames: 16 });
    processor.applyParams!({ gain: 2 });
    const frames = 100;
    const input = new Float32Array(frames).fill(0.5);
    const output = new Float32Array(frames);
    processor.processSeam!(input, output);
    expect(output.every((sample) => sample === 1)).toBe(true);
  });

  it('fills both channels as a source kernel', async () => {
    const processor = await load({ mode: 'source', channels: 2 });
    const left = new Float32Array([1, 1]);
    const right = new Float32Array([-1, -1]);
    const outL = new Float32Array(2);
    const outR = new Float32Array(2);
    processor.processSource!(left, right, outL, outR);
    expect([...outL]).toEqual([1, 1]);
    expect([...outR]).toEqual([-1, -1]);
  });

  it('gives a mono source the same signal on both sides rather than silence', async () => {
    const processor = await load({ mode: 'source', channels: 2 });
    const left = new Float32Array([0.5, 0.5]);
    const outL = new Float32Array(2);
    const outR = new Float32Array(2);
    processor.processSource!(left, null, outL, outR);
    expect([...outR]).toEqual([0.5, 0.5]);
  });

  it('reports what it is, so a host can tell a portable kernel from a built-in one', async () => {
    const processor = await load();
    expect(processor.describe!()).toMatchObject({
      portable: true,
      abi: CRATE_KERNEL_ABI_VERSION,
      name: 'fixture.gain',
      mode: 'seam',
    });
    expect(processor.latencySamples!()).toBe(0);
  });

  it('runs inside a compiled voice at a slot crate core has never heard of', async () => {
    // The whole point: an AudioMaterial names its own slot, and nothing in this
    // build was compiled knowing that name exists.
    const material = new AudioMaterial({
      name: 'Acme Tape',
      kind: 'acme.tape',
      params: {},
      graph: ({ input }) => kernel.seam('acme.tape.kernel', input),
    });
    const voice = compileVoice(material.graph);
    expect(voice.seamSlots).toEqual(['acme.tape.kernel']);

    const state = voice.createState();
    const processor = await load();
    processor.applyParams!({ gain: 0.5 });
    state.kernels = new Map([['acme.tape.kernel', processor]]);

    const out = new Float32Array(8);
    voice.renderBlock(state, SR, out, new Float32Array(8).fill(1));
    expect(out.every((sample) => Math.abs(sample - 0.5) < 1e-6)).toBe(true);
  });
});

describe('portable WASM kernel: refusals', () => {
  it('rejects a descriptor from a future ABI rather than guessing', async () => {
    await expect(load({ abi: 2 as 1 })).rejects.toThrow(/ABI 2/);
  });

  it('rejects a module that is not one', async () => {
    await expect(
      wasmKernelFactory(SR, { binary: new Uint8Array([0, 1, 2, 3]), descriptor }),
    ).rejects.toThrow();
  });

  it('rejects a payload that is not a portable kernel at all', async () => {
    await expect(wasmKernelFactory(SR, { someOtherPlugin: true })).rejects.toThrow(/binary, descriptor/);
  });

  it('recognises a portable payload without instantiating it', () => {
    expect(isWasmKernelPayload({ binary: new Uint8Array(), descriptor: { abi: 1 } })).toBe(true);
    expect(isWasmKernelPayload({ namJson: '{}' })).toBe(false);
    expect(isWasmKernelPayload(null)).toBe(false);
  });
});
