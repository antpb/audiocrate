import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { processAmpMaterial } from './bakeAmp';
import { createAmpMaterial } from './ampMaterial';
import { setAmpNamAsset } from './assets';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../wasm');
const namWasmPath = resolve(wasmDir, 'dist/nam.wasm');
const ampFxWasmPath = resolve(wasmDir, 'dist/amp_fx.wasm');
const lstmNamPath = resolve(wasmDir, 'fixtures/lstm.nam');

const SR = 48000;

function sine(frames: number, freq = 220, amp = 0.3): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

async function loadWasm() {
  const [namWasm, ampFxWasm] = await Promise.all([readFile(namWasmPath), readFile(ampFxWasmPath)]);
  return { namWasmBinary: new Uint8Array(namWasm), ampFxWasmBinary: new Uint8Array(ampFxWasm) };
}

describe('processAmpMaterial: mono default path', () => {
  it('downmixes a stereo clip to mono and broadcasts identical output to both channels when stereoMode is off', async () => {
    const amp = createAmpMaterial();
    amp.setParam('outputGain', 2);
    const left = sine(256, 220, 0.2);
    const right = sine(256, 220, 0.4);
    const [outL, outR] = await processAmpMaterial(amp, [left, right], SR, {});
    for (let i = 0; i < left.length; i++) {
      const expected = 0.5 * (left[i]! + right[i]!) * 2; // default bypass chain: gain*2, NAM identity
      expect(outL![i]).toBeCloseTo(expected, 4);
      expect(outR![i]).toBeCloseTo(expected, 4);
      expect(outL![i]).toBeCloseTo(outR![i]!, 6);
    }
  });
});

describe('processAmpMaterial: eqPostAmp', () => {
  it('with a real (nonlinear) NAM attached, pre-amp vs post-amp EQ ordering audibly differs', async () => {
    // Without a real NAM, `neural.nam` is an identity passthrough, so EQ
    // before vs after it is mathematically the same operation either way
    // (order does not matter around an identity function). A real,
    // nonlinear model is needed to actually distinguish "EQ shapes what NAM
    // sees" from "EQ shapes what NAM produced".
    const { namWasmBinary, ampFxWasmBinary } = await loadWasm();
    const namJson = await readFile(lstmNamPath, 'utf8');

    const ampPre = createAmpMaterial();
    setAmpNamAsset(ampPre, { filename: 'lstm.nam', json: namJson });
    ampPre.setParam('eqBand0', 8);
    const ampPost = createAmpMaterial();
    setAmpNamAsset(ampPost, { filename: 'lstm.nam', json: namJson });
    ampPost.setParam('eqBand0', 8);
    ampPost.setParam('eqPostAmp', 1);

    const input = sine(512);
    const [preOut] = await processAmpMaterial(ampPre, [input], SR, { namWasmBinary, ampFxWasmBinary });
    const [postOut] = await processAmpMaterial(ampPost, [input], SR, { namWasmBinary, ampFxWasmBinary });

    for (let i = 0; i < input.length; i++) {
      expect(Number.isFinite(preOut![i])).toBe(true);
      expect(Number.isFinite(postOut![i])).toBe(true);
    }
    let differs = false;
    for (let i = 0; i < input.length; i++) {
      if (Math.abs(preOut![i]! - postOut![i]!) > 1e-4) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('is an exact bypass at 0 dB EQ regardless of eqPostAmp position', async () => {
    const input = sine(256);
    const ampPre = createAmpMaterial();
    const ampPost = createAmpMaterial();
    ampPost.setParam('eqPostAmp', 1);
    const [preOut] = await processAmpMaterial(ampPre, [input], SR, {});
    const [postOut] = await processAmpMaterial(ampPost, [input], SR, {});
    for (let i = 0; i < input.length; i++) {
      expect(preOut![i]).toBeCloseTo(input[i]!, 4);
      expect(postOut![i]).toBeCloseTo(input[i]!, 4);
    }
  });
});

describe('processAmpMaterial: stereo companion', () => {
  it('clones the primary NAM for the right channel when channelLink is on, applying independent gain only when volLink is off', async () => {
    const { namWasmBinary, ampFxWasmBinary } = await loadWasm();
    const namJson = await readFile(lstmNamPath, 'utf8');
    const amp = createAmpMaterial();
    setAmpNamAsset(amp, { filename: 'lstm.nam', json: namJson });
    amp.setParam('stereoMode', 1);
    amp.setParam('volLink', 0);
    amp.setParam('outputGainR', 2);

    const left = sine(512, 220, 0.2);
    const right = sine(512, 220, 0.2); // identical dry signal on both channels
    const [outL, outR] = await processAmpMaterial(amp, [left, right], SR, { namWasmBinary, ampFxWasmBinary });

    // Same model, same input, but R has 2x output gain -> R should be ~2x L (allowing for the
    // WASM NAM's own nonlinearity meaning this holds on well-matched instances, not bit-exact).
    let ratioSum = 0;
    let count = 0;
    for (let i = 100; i < left.length; i++) {
      if (Math.abs(outL![i]!) > 1e-4) {
        ratioSum += outR![i]! / outL![i]!;
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(Math.abs(ratioSum / count - 2)).toBeLessThan(0.1);
  });

  it('invertR flips the right channel polarity', async () => {
    const amp = createAmpMaterial();
    amp.setParam('stereoMode', 1);
    amp.setParam('invertR', 1);
    const left = sine(256, 220, 0.2);
    const right = sine(256, 220, 0.2);
    const [outL, outR] = await processAmpMaterial(amp, [left, right], SR, {});
    for (let i = 0; i < left.length; i++) {
      expect(outR![i]).toBeCloseTo(-outL![i]!, 5);
    }
  });

  it('uses the independent companion NAM for the right channel when channelLink is off', async () => {
    const { namWasmBinary, ampFxWasmBinary } = await loadWasm();
    const namJson = await readFile(lstmNamPath, 'utf8');
    const amp = createAmpMaterial();
    setAmpNamAsset(amp, { filename: 'lstm.nam', json: namJson }); // profile A: real NAM
    // profile B (namAssetR) left undefined -> passthrough, so L (real NAM) and R (identity) must differ.
    amp.setParam('stereoMode', 1);
    amp.setParam('channelLink', 0);

    const left = sine(512, 220, 0.3);
    const right = sine(512, 220, 0.3);
    const [outL, outR] = await processAmpMaterial(amp, [left, right], SR, { namWasmBinary, ampFxWasmBinary });

    let differs = false;
    for (let i = 0; i < left.length; i++) {
      if (Math.abs(outL![i]! - outR![i]!) > 1e-4) differs = true;
    }
    expect(differs).toBe(true);
  });
});

describe('processAmpMaterial: morph A/B', () => {
  it('with nothing targeted, morph is a no-op (output matches profile A exactly)', async () => {
    const amp = createAmpMaterial();
    amp.setParam('morphEnable', 1);
    amp.setParam('morphTargetAmp', 0);
    amp.setParam('morphTargetIR', 0);
    const input = sine(512, 220, 0.4);
    const [morphed] = await processAmpMaterial(amp, [input], SR, {});
    const [plain] = await processAmpMaterial(createAmpMaterial(), [input], SR, {});
    for (let i = 0; i < input.length; i++) {
      expect(morphed![i]).toBeCloseTo(plain![i]!, 4);
    }
  });

  it('a loud-then-quiet signal sweeps toward profile B and back when targeting amp', async () => {
    const { namWasmBinary, ampFxWasmBinary } = await loadWasm();
    const namJson = await readFile(lstmNamPath, 'utf8');
    const amp = createAmpMaterial();
    setAmpNamAsset(amp, { filename: 'A.nam', json: namJson }); // profile A: real NAM
    // profile B (namAssetR) undefined -> identity passthrough, so a real morph sweep is audible.
    amp.setParam('morphEnable', 1);
    amp.setParam('morphThreshold', 0.1);
    amp.setParam('morphSensitivity', 0.9);
    amp.setParam('morphDepth', 1);

    const totalFrames = 24000;
    const input = new Float32Array(totalFrames);
    for (let i = 0; i < 4000; i++) input[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
    // remaining samples stay at 0 (quiet) so the detector settles back toward manual/profile A.

    const [wet] = await processAmpMaterial(amp, [input], SR, { namWasmBinary, ampFxWasmBinary });
    for (const s of wet!) expect(Number.isFinite(s)).toBe(true);

    // Loud region should differ from a pure profile-A render (morph pulled toward B, the
    // identity passthrough); quiet tail should have decayed back toward 0 either way.
    const [profileAOnly] = await processAmpMaterial(
      (() => {
        const a = createAmpMaterial();
        setAmpNamAsset(a, { filename: 'A.nam', json: namJson });
        return a;
      })(),
      [input],
      SR,
      { namWasmBinary, ampFxWasmBinary },
    );
    let differsWhileLoud = false;
    for (let i = 500; i < 4000; i++) {
      if (Math.abs(wet![i]! - profileAOnly![i]!) > 1e-4) differsWhileLoud = true;
    }
    expect(differsWhileLoud).toBe(true);
  });
});
