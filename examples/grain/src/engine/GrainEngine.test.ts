import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OfflineRenderer } from '../crate';
import { grainMaterial } from '../grainMaterial';
import { GRAIN_KERNEL_SLOT } from '../kernelSlot';
import { grainKernelFactory } from '../kernel';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../wasm/dist/grain_fx.wasm');
const SR = 48000;
const FADE = 1024;

/**
 * Builds the engine the way the host does: through the kernel factory, so
 * this exercises the crate-facing adapter and not just the raw WASM binding.
 */
async function loadGrain() {
  const wasm = new Uint8Array(await readFile(wasmPath)) as unknown as ArrayBuffer;
  return grainKernelFactory(SR, { wasm });
}

function sine(frames: number, freq = 220, amp = 0.2): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe('Grain WASM', () => {
  it('is a dry passthrough at defaults after the start fade', async () => {
    const grain = await loadGrain();
    const inputSignal = sine(FADE + 256);
    const wet = OfflineRenderer.render(grainMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: grainMaterial.snapshotParams(),
      inputSignal,
      kernels: { [GRAIN_KERNEL_SLOT]: grain },
    });
    let maxErr = 0;
    for (let i = FADE; i < wet.samples.length; i++) {
      expect(Number.isFinite(wet.samples[i])).toBe(true);
      maxErr = Math.max(maxErr, Math.abs(wet.samples[i]! - inputSignal[i]!));
    }
    expect(maxErr).toBeLessThan(0.02);
    grain.dispose?.();
  });

  it('grainMix changes the signal after the ring has been written', async () => {
    const grain = await loadGrain();
    const inputSignal = sine(4096, 330, 0.3);
    const params = { ...grainMaterial.snapshotParams(), grainMix: 0.85, grainDensity: 40 };
    const wet = OfflineRenderer.render(grainMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params,
      inputSignal,
      kernels: { [GRAIN_KERNEL_SLOT]: grain },
    });
    let differs = false;
    for (let i = FADE; i < wet.samples.length; i++) {
      expect(Number.isFinite(wet.samples[i])).toBe(true);
      if (Math.abs(wet.samples[i]! - inputSignal[i]!) > 1e-3) differs = true;
    }
    expect(differs).toBe(true);
    grain.dispose?.();
  });
});
