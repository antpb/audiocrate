import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OfflineRenderer } from '../crate';
import { spaceReverbMaterial } from '../spaceReverbMaterial';
import { SPACE_REVERB_KERNEL_SLOT } from '../kernelSlot';
import { spaceReverbKernelFactory } from '../kernel';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../wasm/dist/space_reverb.wasm');
const SR = 48000;

async function loadFx() {
  const wasm = new Uint8Array(await readFile(wasmPath)) as unknown as ArrayBuffer;
  return spaceReverbKernelFactory(SR, { wasm });
}

function sine(frames: number, freq = 220, amp = 0.2): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe('Space Reverb WASM', () => {
  it('is an exact bypass at blend 0', async () => {
    const fx = await loadFx();
    const inputSignal = sine(256);
    const dry = OfflineRenderer.render(spaceReverbMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: { ...spaceReverbMaterial.snapshotParams(), reverbBlend: 0 },
      inputSignal,
    });
    const wet = OfflineRenderer.render(spaceReverbMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: { ...spaceReverbMaterial.snapshotParams(), reverbBlend: 0 },
      inputSignal,
      kernels: { [SPACE_REVERB_KERNEL_SLOT]: fx },
    });
    for (let i = 0; i < dry.samples.length; i++) {
      expect(wet.samples[i]).toBeCloseTo(dry.samples[i]!, 5);
    }
    fx.dispose?.();
  });

  it('Costello changes the tail when blend is up', async () => {
    const fx = await loadFx();
    const inputSignal = sine(512);
    const params = { ...spaceReverbMaterial.snapshotParams(), reverbBlend: 0.6, reverbDecay: 0.8 };
    const wet = OfflineRenderer.render(spaceReverbMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params,
      inputSignal,
      kernels: { [SPACE_REVERB_KERNEL_SLOT]: fx },
    });
    let differs = false;
    for (let i = 0; i < wet.samples.length; i++) {
      expect(Number.isFinite(wet.samples[i])).toBe(true);
      if (Math.abs(wet.samples[i]! - inputSignal[i]!) > 1e-4) differs = true;
    }
    expect(differs).toBe(true);
    fx.dispose?.();
  });

  it('reverbGate closes the tail once input goes quiet', async () => {
    const totalFrames = 48000;
    const inputSignal = new Float32Array(totalFrames);
    for (let i = 0; i < 8000; i++) inputSignal[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const baseParams = { ...spaceReverbMaterial.snapshotParams(), reverbBlend: 0.8, reverbDecay: 0.9 };

    const rmsFrom = (arr: Float32Array, from: number) => {
      let sum = 0;
      for (let i = from; i < arr.length; i++) sum += arr[i]! * arr[i]!;
      return Math.sqrt(sum / (arr.length - from));
    };

    const fxUngated = await loadFx();
    const ungated = OfflineRenderer.render(spaceReverbMaterial.graph, {
      duration: totalFrames / SR,
      sampleRate: SR,
      params: { ...baseParams, reverbGate: 0 },
      inputSignal,
      kernels: { [SPACE_REVERB_KERNEL_SLOT]: fxUngated },
    });
    fxUngated.dispose?.();

    const fxGated = await loadFx();
    const gated = OfflineRenderer.render(spaceReverbMaterial.graph, {
      duration: totalFrames / SR,
      sampleRate: SR,
      params: { ...baseParams, reverbGate: 1 },
      inputSignal,
      kernels: { [SPACE_REVERB_KERNEL_SLOT]: fxGated },
    });
    fxGated.dispose?.();

    const tailStart = 38000;
    const ungatedTail = rmsFrom(ungated.samples, tailStart);
    const gatedTail = rmsFrom(gated.samples, tailStart);
    expect(ungatedTail).toBeGreaterThan(1e-4);
    expect(gatedTail).toBeLessThan(ungatedTail * 0.05);
  });
});
