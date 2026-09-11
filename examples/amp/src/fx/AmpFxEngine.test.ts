import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OfflineRenderer } from '../crate';
import { ampMaterial } from '../ampMaterial';
import { AMP_KERNEL_SLOT } from '../kernelSlot';
import { ampKernelFactory } from '../kernel';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../wasm/dist/amp_fx.wasm');
const SR = 48000;

/**
 * Builds the FX stages through the plugin's own kernel factory, so this
 * exercises the crate-facing adapter and not just the raw WASM binding. No
 * profile is supplied, which is a real configuration: the analog path.
 */
async function loadFx() {
  const ampFxWasm = new Uint8Array(await readFile(wasmPath)) as unknown as ArrayBuffer;
  return ampKernelFactory(SR, { ampFxWasm });
}

function sine(frames: number, freq = 220, amp = 0.2): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe('AmpFx WASM', () => {
  it('is an exact bypass at default mix/blend with no IR', async () => {
    const fx = await loadFx();
    const inputSignal = sine(256);
    const dry = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: ampMaterial.snapshotParams(),
      inputSignal,
    });
    const wet = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: ampMaterial.snapshotParams(),
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: fx },
    });
    for (let i = 0; i < dry.samples.length; i++) {
      expect(wet.samples[i]).toBeCloseTo(dry.samples[i]!, 5);
    }
    fx.dispose?.();
  });

  it('Costello reverb changes the tail when blend is up', async () => {
    const fx = await loadFx();
    const inputSignal = sine(512);
    const params = { ...ampMaterial.snapshotParams(), reverbBlend: 0.6, reverbDecay: 0.8 };
    const wet = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params,
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: fx },
    });
    let differs = false;
    for (let i = 0; i < wet.samples.length; i++) {
      expect(Number.isFinite(wet.samples[i])).toBe(true);
      if (Math.abs(wet.samples[i]! - inputSignal[i]!) > 1e-4) differs = true;
    }
    expect(differs).toBe(true);
    fx.dispose?.();
  });

  it('delay changes the signal when mix is up', async () => {
    const fx = await loadFx();
    const inputSignal = sine(1024, 330, 0.25);
    const params = { ...ampMaterial.snapshotParams(), delayMix: 0.7, delayTime: 80, delayFeedback: 0.4 };
    const wet = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params,
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: fx },
    });
    let differs = false;
    for (let i = 0; i < wet.samples.length; i++) {
      expect(Number.isFinite(wet.samples[i])).toBe(true);
      if (Math.abs(wet.samples[i]! - inputSignal[i]!) > 1e-4) differs = true;
    }
    expect(differs).toBe(true);
    fx.dispose?.();
  });

  it('reverbGate closes the pre-amp reverb tail once input goes quiet', async () => {
    const totalFrames = 48000;
    const inputSignal = new Float32Array(totalFrames);
    for (let i = 0; i < 8000; i++) inputSignal[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const baseParams = { ...ampMaterial.snapshotParams(), reverbPreAmp: 1, reverbBlend: 0.8, reverbDecay: 0.9 };

    const rmsFrom = (arr: Float32Array, from: number) => {
      let sum = 0;
      for (let i = from; i < arr.length; i++) sum += arr[i]! * arr[i]!;
      return Math.sqrt(sum / (arr.length - from));
    };

    const fxUngated = await loadFx();
    const ungated = OfflineRenderer.render(ampMaterial.graph, {
      duration: totalFrames / SR,
      sampleRate: SR,
      params: { ...baseParams, reverbGate: 0 },
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: fxUngated },
    });
    fxUngated.dispose?.();

    const fxGated = await loadFx();
    const gated = OfflineRenderer.render(ampMaterial.graph, {
      duration: totalFrames / SR,
      sampleRate: SR,
      params: { ...baseParams, reverbGate: 1 },
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: fxGated },
    });
    fxGated.dispose?.();

    // Envelope release (~240ms to cross the close threshold from a 0.5-peak
    // signal) plus the gate's own ~210ms VCA release only fully bottoms out
    // well after 450ms; measure the tail comfortably past that.
    const tailStart = 38000;
    const ungatedTail = rmsFrom(ungated.samples, tailStart);
    const gatedTail = rmsFrom(gated.samples, tailStart);
    expect(ungatedTail).toBeGreaterThan(1e-4); // the reverb genuinely still rings without the gate
    expect(gatedTail).toBeLessThan(ungatedTail * 0.05); // the gate closes it down hard
  });

  it('IR reports 512-sample latency and is not a passthrough', async () => {
    const fx = await loadFx();
    const ir = new Float32Array(64);
    ir[0] = 1;
    ir[32] = 0.5;
    // Assets reach a kernel as messages, not method calls: that is the only
    // channel available once the kernel lives in a worklet realm.
    expect(fx.onMessage?.({ type: 'setIR', samples: ir })).toEqual({ latencySamples: 512 });
    expect(fx.latencySamples?.()).toBe(512);

    const inputSignal = sine(256);
    const wet = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: ampMaterial.snapshotParams(),
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: fx },
    });
    let differs = false;
    for (let i = 0; i < wet.samples.length; i++) {
      expect(Number.isFinite(wet.samples[i])).toBe(true);
      if (Math.abs(wet.samples[i]! - inputSignal[i]!) > 1e-5) differs = true;
    }
    expect(differs).toBe(true);
    fx.dispose?.();
  });
});
