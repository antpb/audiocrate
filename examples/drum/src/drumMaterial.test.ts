import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileVoice } from '../../../src/asl/compile';
import { createDrumMaterial, drumPluginMaterial } from './drumMaterial';
import { NUM_PADS, PAD_BASE_NOTE, drumParams, padParamName } from './drumParams';
import { drumPadBoxes, setDrumPadAsset } from './drumPads';

const SR = 48000;

/**
 * A short decaying tone, loud enough that a triggered pad is unmistakable.
 *
 * A tone and not an impulse train: the pad chain ends in a low-pass, so a
 * sample alternating every frame sits at Nyquist and the filter is entitled
 * to remove all of it. That looks exactly like a pad that failed to trigger.
 */
function clickSample(frames = 512): Float32Array {
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * Math.exp(-i / 400) * 0.8;
  }
  return samples;
}

function loadedMaterial() {
  const material = createDrumMaterial({ sampleRate: SR });
  for (let pad = 0; pad < NUM_PADS; pad++) {
    setDrumPadAsset(material, pad, { filename: `pad${pad}.wav`, samples: clickSample(), sampleRate: SR });
  }
  return material;
}

function peak(block: Float32Array): number {
  let worst = 0;
  for (const v of block) worst = Math.max(worst, Math.abs(v));
  return worst;
}

describe('drum parameter tree', () => {
  it('carries every AUv3 address the Swift enum declares', () => {
    // The enum is the source of truth and it is vendored beside this package,
    // so the check is against the file rather than against a copy of it.
    const source = readFileSync(
      fileURLToPath(new URL('../params/homecrate_drumParameterAddresses.swift', import.meta.url)),
      'utf8',
    );
    const swift = new Map<string, number>();
    for (const line of source.split('\n')) {
      const match = /^\s*case\s+(\w+)\s*=\s*(\d+)/.exec(line);
      if (match) swift.set(match[1]!, Number(match[2]));
    }
    expect(swift.size).toBe(249);

    // The three sample-record addresses are host capture state rather than
    // anything a kit carries, so they are the only ones left out.
    const skipped = new Set(['sampleRecordMode', 'sampleRecordLevel', 'sampleRecordThreshold']);
    for (const [name, address] of swift) {
      if (skipped.has(name)) continue;
      expect(drumParams[name], `missing param ${name}`).toBeDefined();
      expect(drumParams[name]!.address, `wrong address for ${name}`).toBe(address);
    }
    expect(Object.keys(drumParams)).toHaveLength(swift.size - skipped.size);
  });

  it('names pad params the way the AU identifies them', () => {
    expect(padParamName('cut', 7)).toBe('pad7Cut');
    expect(drumParams.pad7Cut?.address).toBe(71);
    expect(drumParams.pad0Vol?.default).toBe(1);
    expect(drumParams.pad0Bits?.min).toBe(4);
    expect(drumParams.masterVol?.address).toBe(100);
  });
});

describe('drum material', () => {
  it('is one voice with sixteen playheads, not sixteen voices', () => {
    expect(drumPluginMaterial.polyphony).toBe(1);
    expect(drumPluginMaterial.kind).toBe('drum');
  });

  it('is silent with no samples loaded', () => {
    const material = createDrumMaterial({ sampleRate: SR });
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 1 });
    const out = new Float32Array(256);
    voice.renderBlock(state, SR, out, undefined, { outputR: new Float32Array(256) });
    expect(peak(out)).toBe(0);
  });

  it('holds one sample buffer per pad, addressed by pad number', () => {
    const material = loadedMaterial();
    const boxes = drumPadBoxes(material);
    expect(boxes).toHaveLength(NUM_PADS);
    expect(boxes![3]!.samples.length).toBe(512);
  });

  it('sounds the pad the note selects and leaves the other fifteen silent', () => {
    const material = loadedMaterial();
    // Everything but pad 5 muted, so anything audible had to come from pad 5.
    for (let pad = 0; pad < NUM_PADS; pad++) {
      if (pad !== 5) material.setParam(padParamName('vol', pad), 0);
    }
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    const out = new Float32Array(256);

    voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE + 5, velocity: 1 });
    voice.renderBlock(state, SR, out, undefined, { outputR: new Float32Array(256) });
    expect(peak(out)).toBeGreaterThan(0.1);

    const other = new Float32Array(256);
    const state2 = voice.createState();
    voice.noteOn(state2, { ...material.snapshotParams(), note: PAD_BASE_NOTE + 6, velocity: 1 });
    voice.renderBlock(state2, SR, other, undefined, { outputR: new Float32Array(256) });
    expect(peak(other)).toBe(0);
  });

  it('keeps a one-shot running through the note-off, the way the AU ignores them', () => {
    const material = loadedMaterial();
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    const out = new Float32Array(32);

    voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 1 });
    voice.renderBlock(state, SR, out, undefined, { outputR: new Float32Array(32) });
    voice.noteOff(state);
    const after = new Float32Array(32);
    voice.renderBlock(state, SR, after, undefined, { outputR: new Float32Array(32) });
    expect(peak(after)).toBeGreaterThan(0.05);
  });

  it('latches each pad velocity, so a later hit does not rescale a ringing one', () => {
    // The AU keeps `padVelocities[i]` from note-on. Without the per-pad latch
    // the whole voice would carry one velocity and a quiet hat would pull a
    // loud kick down mid-decay.
    const material = loadedMaterial();
    for (let pad = 0; pad < NUM_PADS; pad++) {
      if (pad !== 0) material.setParam(padParamName('vol', pad), 0);
    }
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    const params = material.snapshotParams();

    const loud = new Float32Array(64);
    voice.noteOn(state, { ...params, note: PAD_BASE_NOTE, velocity: 1 });
    voice.renderBlock(state, SR, loud, undefined, { outputR: new Float32Array(64) });

    // Pad 1 at a whisper while pad 0 is still ringing.
    voice.noteOff(state);
    voice.noteOn(state, { ...params, note: PAD_BASE_NOTE + 1, velocity: 0.05 });
    const stillLoud = new Float32Array(64);
    voice.renderBlock(state, SR, stillLoud, undefined, { outputR: new Float32Array(64) });

    const reference = new Float32Array(64);
    const solo = voice.createState();
    voice.noteOn(solo, { ...params, note: PAD_BASE_NOTE, velocity: 1 });
    voice.renderBlock(solo, SR, reference, undefined, { outputR: new Float32Array(64) });
    voice.renderBlock(solo, SR, reference, undefined, { outputR: new Float32Array(64) });

    for (let i = 0; i < 64; i++) {
      expect(stillLoud[i]).toBeCloseTo(reference[i]!, 5);
    }
  });

  it('pans a pad across the two channels with the AU equal-power law', () => {
    const material = loadedMaterial();
    for (let pad = 1; pad < NUM_PADS; pad++) material.setParam(padParamName('vol', pad), 0);
    material.setParam('pad0Pan', -1);
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    const left = new Float32Array(64);
    const right = new Float32Array(64);
    voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 1 });
    voice.renderBlock(state, SR, left, undefined, { outputR: right });
    expect(peak(left)).toBeGreaterThan(0.1);
    expect(peak(right)).toBeLessThan(1e-6);
  });
});
