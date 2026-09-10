/**
 * The worked example in `examples/portable-kernel/`, loaded the way a
 * third-party Material would load it.
 *
 * `wasmKernel.test.ts` already proves the loader against
 * `testing/wasmKernelFixture.ts`, a module assembled byte by byte with no
 * toolchain involved. That fixture proves the ABI is small enough to hit from
 * anywhere, and it proves nothing about whether a person with a compiler can
 * hit it, because nobody ships DSP written as an opcode array.
 *
 * This runs the artefact from the documented build instead: real C, compiled
 * by the command in `examples/portable-kernel/build.sh`, checked in so this
 * test needs no wasm toolchain. If the instructions in `docs/kernels.md` stop
 * producing a module crate can load, this is what says so.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { wasmKernelFactory, type WasmKernelDescriptor } from '../../../src/renderers/kernels/wasmKernel';

const BINARY = readFileSync(
  fileURLToPath(new URL('../../../examples/portable-kernel/tremolo.wasm', import.meta.url)),
);

const SR = 48000;

/** The descriptor that ships beside the binary. Plain JSON, by necessity: it
 *  has to survive `postMessage` into the worklet realm. */
const DESCRIPTOR: WasmKernelDescriptor = {
  abi: 1,
  name: 'example.tremolo',
  mode: 'seam',
  params: { rate: 0, depth: 1 },
  maxFrames: 128,
};

async function load(params?: Record<string, number>) {
  return wasmKernelFactory(SR, { binary: BINARY, descriptor: DESCRIPTOR, params });
}

function dc(frames: number, value = 1): Float32Array {
  return new Float32Array(frames).fill(value);
}

describe('the portable kernel example', () => {
  it('loads through the same factory a third-party Material would use', async () => {
    const kernel = await load();
    expect(kernel.describe?.()).toMatchObject({
      portable: true,
      abi: 1,
      name: 'example.tremolo',
      mode: 'seam',
      latencySamples: 0,
    });
  });

  it('modulates the signal it is given', async () => {
    const kernel = await load({ rate: 400, depth: 1 });
    const input = dc(512);
    const output = new Float32Array(512);
    kernel.processSeam!(input, output);

    // A tremolo on DC is the LFO. Asserting that the output moves, rather
    // than asserting exact samples, because the point of this test is that
    // the toolchain produced something live: the numbers themselves are the
    // C file's business.
    const min = output.reduce((a, v) => Math.min(a, v), Infinity);
    const max = output.reduce((a, v) => Math.max(a, v), -Infinity);
    expect(max).toBeGreaterThan(0.9);
    expect(min).toBeLessThan(0.1);
  });

  it('is exactly transparent at zero depth', async () => {
    // The C file claims a bypassed tremolo is bit-identical to no tremolo
    // rather than nearly so. Worth pinning: "almost unity" in an insert is
    // how a chain of bypassed effects quietly loses a decibel.
    const kernel = await load({ rate: 5, depth: 0 });
    const input = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 9) * 0.7);
    const output = new Float32Array(256);
    kernel.processSeam!(input, output);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it('processes a block longer than it was initialised for', async () => {
    // The module holds 1024 frames and declares maxFrames 128, so a 512-frame
    // block is four chunks. Truncating instead of chunking would leave the
    // tail of every long block untouched, which is silent in a test that only
    // looks at the head.
    const kernel = await load({ rate: 400, depth: 1 });
    const input = dc(512);
    const output = new Float32Array(512).fill(NaN);
    kernel.processSeam!(input, output);
    expect(output.some(Number.isNaN)).toBe(false);
  });

  it('refuses a block size it cannot hold, rather than clamping', async () => {
    // MAX_FRAMES in the C file is 1024, and crate_init returns 0 above that.
    // A kernel that clamped would process the first 1024 frames of every
    // block and pass the rest through untouched.
    await expect(
      wasmKernelFactory(SR, {
        binary: BINARY,
        descriptor: { ...DESCRIPTOR, maxFrames: 4096 },
      }),
    ).rejects.toThrow(/refused to start/);
  });
});
