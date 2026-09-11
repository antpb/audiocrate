/**
 * The amp on crate's generic bake path. This used to live in crate as
 * `bakeInserts.test.ts`, where it made crate's own test suite depend on
 * homecrate's WASM. It belongs here: crate proves the bake mechanism against a
 * plugin it invented, and this proves homecrate's plugin plugs into it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bakeTrackInserts,
  Clip,
  AudioMaterialRegistry,
  Time,
  Track,
  type AudioBufferLike,
} from './crate';
import { createAmpMaterial } from './ampMaterial';
import { setAmpNamAsset } from './assets';
import { ampPlugin } from './plugin';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../wasm');
const namWasmPath = resolve(wasmDir, 'dist/nam.wasm');
const ampFxWasmPath = resolve(wasmDir, 'dist/amp_fx.wasm');
const lstmNamPath = resolve(wasmDir, 'fixtures/lstm.nam');

const SR = 48000;
const registry = new AudioMaterialRegistry().register(ampPlugin);

function trackWithClip(buffer: AudioBufferLike): Track {
  const track = new Track({ name: 'T' });
  track.addClip(new Clip({ buffer }), { at: Time.seconds(0) });
  return track;
}

function monoBuffer(samples: Float32Array | number[]): AudioBufferLike {
  const data = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  return { sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}

describe('amp on bakeTrackInserts', () => {
  it('bakes the EQ/gain chain with no WASM at all, leaving inference a passthrough', async () => {
    const amp = createAmpMaterial();
    amp.setParam('outputGain', 2);
    const track = trackWithClip(monoBuffer([0.1, -0.2, 0.3, -0.4]));
    track.materials.add(amp);

    const baked = await bakeTrackInserts([track], { registry });
    const data = baked.get(track.clips[0]!.clip.id)!.getChannelData(0);
    expect(data.length).toBe(4);
    expect(Array.from(data)).toEqual([0.1, -0.2, 0.3, -0.4].map((s) => expect.closeTo(s * 2, 4)));
  });

  it('runs real NAM inference when the binaries and assets are present', async () => {
    const [namJson, namWasm, ampFxWasm] = await Promise.all([
      readFile(lstmNamPath, 'utf8'),
      readFile(namWasmPath),
      readFile(ampFxWasmPath),
    ]);

    const amp = createAmpMaterial();
    setAmpNamAsset(amp, { filename: 'lstm.nam', json: namJson });

    const input = new Float32Array(256);
    for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const track = trackWithClip(monoBuffer(input));
    track.materials.add(amp);

    const bypassBaked = await bakeTrackInserts([track], { registry });
    const wasmBaked = await bakeTrackInserts([track], {
      registry,
      binaries: { nam: new Uint8Array(namWasm) as unknown as ArrayBuffer, ampFx: new Uint8Array(ampFxWasm) as unknown as ArrayBuffer },
    });

    const clipId = track.clips[0]!.clip.id;
    const bypassData = bypassBaked.get(clipId)!.getChannelData(0);
    const wasmData = wasmBaked.get(clipId)!.getChannelData(0);

    expect(wasmData.length).toBe(input.length);
    for (const sample of wasmData) expect(Number.isFinite(sample)).toBe(true);

    let maxDiff = 0;
    for (let i = 0; i < wasmData.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(wasmData[i]! - bypassData[i]!));
    }
    expect(maxDiff).toBeGreaterThan(1e-4);
  });

  it('reports no cabinet hop; convolution lives on the IR AudioMaterial', () => {
    const dry = createAmpMaterial();
    const wet = createAmpMaterial();
    ampPlugin.applyPreset!(wet, { params: {}, irFilename: 'cab.wav', raw: {} });

    expect(ampPlugin.latencySamples!(dry)).toBe(0);
    expect(ampPlugin.latencySamples!(wet)).toBe(0);
  });
});
