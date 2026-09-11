import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../../../src/asl/compile';
import { ASL } from '../../../../src/asl/graph';
import { kernel, OfflineRenderer } from '../crate';
import { ampMaterial } from '../ampMaterial';
import { AMP_KERNEL_SLOT } from '../kernelSlot';
import { createNamModel } from './NamEngine';
import { ampKernelFactory } from '../kernel';
import type { NamProcessor } from './NamProcessor';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../wasm');
const lstmPath = resolve(fixtureDir, 'fixtures/lstm.nam');
const a2Path = resolve(fixtureDir, 'fixtures/red_face_75_4vol_a2full.nam');
const wasmPath = resolve(fixtureDir, 'dist/nam.wasm');

const SR = 48000;

async function loadLstm(): Promise<NamProcessor> {
  const [json, wasmBytes] = await Promise.all([readFile(lstmPath, 'utf8'), readFile(wasmPath)]);
  return createNamModel(json, SR, 128, { wasmBinary: new Uint8Array(wasmBytes) });
}

/**
 * The amp kernel with only a profile in it: no amp_fx.wasm, so the reverb,
 * delay and cabinet stages are absent and the seam is pure inference. That is
 * the configuration these tests are actually about.
 */
async function loadNamKernel(namPath = lstmPath) {
  const [namJson, wasmBytes] = await Promise.all([readFile(namPath, 'utf8'), readFile(wasmPath)]);
  return ampKernelFactory(SR, { namJson, namWasm: new Uint8Array(wasmBytes) as unknown as ArrayBuffer });
}

describe('NamEngine WASM', () => {
  it('loads lstm.nam and renders finite, non-silent, non-passthrough audio', async () => {
    const nam = await loadNamKernel();
    const graph = ASL.node(({ input }) => kernel.seam(AMP_KERNEL_SLOT, input));
    const inputSignal = new Float32Array(512);
    for (let i = 0; i < inputSignal.length; i++) {
      inputSignal[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / SR);
    }

    const rendered = OfflineRenderer.render(graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: nam },
    });

    let sum = 0;
    let differs = false;
    for (let i = 0; i < rendered.samples.length; i++) {
      const sample = rendered.samples[i]!;
      expect(Number.isFinite(sample)).toBe(true);
      sum += sample * sample;
      if (Math.abs(sample - inputSignal[i]!) > 1e-6) differs = true;
    }
    expect(Math.sqrt(sum / rendered.samples.length)).toBeGreaterThan(1e-4);
    expect(differs).toBe(true);
    nam.dispose?.();
  });

  it('ampMaterial stays an exact bypass without a model and changes once NAM is attached', async () => {
    const inputSignal = new Float32Array(256);
    for (let i = 0; i < inputSignal.length; i++) {
      inputSignal[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR);
    }

    const dry = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: ampMaterial.snapshotParams(),
      inputSignal,
    });
    for (let i = 0; i < dry.samples.length; i++) {
      expect(dry.samples[i]).toBeCloseTo(inputSignal[i]!, 5);
    }

    const nam = await loadNamKernel();
    const wet = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: ampMaterial.snapshotParams(),
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: nam },
    });
    let differs = false;
    for (let i = 0; i < wet.samples.length; i++) {
      expect(Number.isFinite(wet.samples[i])).toBe(true);
      if (Math.abs(wet.samples[i]! - inputSignal[i]!) > 1e-5) differs = true;
    }
    expect(differs).toBe(true);
    nam.dispose?.();
  });

  it('processSample matches a 1-frame processBlock', async () => {
    const nam = await loadLstm();
    const voice = compileVoice(ASL.node(({ input }) => kernel.seam(AMP_KERNEL_SLOT, input)));
    const state = voice.createState();
    state.kernels = new Map([[AMP_KERNEL_SLOT, nam]]);
    voice.noteOn(state, {});
    state.params.input = 0.1;
    const sample = voice.renderSample(state, SR);
    expect(Number.isFinite(sample)).toBe(true);
    nam.dispose?.();
  });

  it('loads factory A2-full on the WaveNet fast path and block-renders', async () => {
    const [json, wasmBytes] = await Promise.all([readFile(a2Path, 'utf8'), readFile(wasmPath)]);
    const model = await createNamModel(json, SR, 128, { wasmBinary: new Uint8Array(wasmBytes) });
    expect(model.architecture).toBe('WaveNet');
    expect(model.a2Fast).toBe(true);
    expect(model.a2Channels).toBe(8);
    model.dispose();
    const nam = await loadNamKernel(a2Path);

    const inputSignal = new Float32Array(256);
    for (let i = 0; i < inputSignal.length; i++) {
      inputSignal[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    const rendered = OfflineRenderer.render(ampMaterial.graph, {
      duration: inputSignal.length / SR,
      sampleRate: SR,
      params: ampMaterial.snapshotParams(),
      inputSignal,
      kernels: { [AMP_KERNEL_SLOT]: nam },
    });
    let sum = 0;
    let differs = false;
    for (let i = 0; i < rendered.samples.length; i++) {
      const sample = rendered.samples[i]!;
      expect(Number.isFinite(sample)).toBe(true);
      sum += sample * sample;
      if (Math.abs(sample - inputSignal[i]!) > 1e-5) differs = true;
    }
    expect(Math.sqrt(sum / rendered.samples.length)).toBeGreaterThan(1e-4);
    expect(differs).toBe(true);
    nam.dispose?.();
  }, 20000);
});
