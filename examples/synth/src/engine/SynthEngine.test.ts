import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OfflineRenderer } from '../crate';
import { synthPluginMaterial } from '../synthMaterial';
import { SYNTH_KERNEL_SLOT } from '../kernelSlot';
import { synthKernelFactory } from '../kernel';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../wasm/dist/synth_fx.wasm');
const SR = 48000;

async function loadSynth() {
  const wasm = new Uint8Array(await readFile(wasmPath)) as unknown as ArrayBuffer;
  return synthKernelFactory(SR, { wasm });
}

describe('Synth WASM', () => {
  it('is silent until a note-on, then produces audio', async () => {
    const synth = await loadSynth();
    synth.applyParams?.(synthPluginMaterial.snapshotParams());

    const silent = OfflineRenderer.render(synthPluginMaterial.graph, {
      duration: 0.05,
      sampleRate: SR,
      params: synthPluginMaterial.snapshotParams(),
      kernels: { [SYNTH_KERNEL_SLOT]: synth },
    });
    let silentPeak = 0;
    for (const sample of silent.samples) {
      expect(Number.isFinite(sample)).toBe(true);
      silentPeak = Math.max(silentPeak, Math.abs(sample));
    }
    expect(silentPeak).toBeLessThan(1e-4);

    synth.noteOn?.(60, 0.85);
    const held = OfflineRenderer.render(synthPluginMaterial.graph, {
      duration: 0.2,
      sampleRate: SR,
      params: synthPluginMaterial.snapshotParams(),
      kernels: { [SYNTH_KERNEL_SLOT]: synth },
    });
    let heldPeak = 0;
    for (let i = 1024; i < held.samples.length; i++) {
      expect(Number.isFinite(held.samples[i])).toBe(true);
      heldPeak = Math.max(heldPeak, Math.abs(held.samples[i]!));
    }
    expect(heldPeak).toBeGreaterThan(0.01);
    synth.dispose?.();
  });
});
