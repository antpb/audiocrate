/**
 * The whole path a pad press takes, end to end.
 *
 * The unit tests above prove the graph triggers and the kit is well formed.
 * Neither would have caught a kit that decodes to silence, a factory setting
 * that mutes the bus, or an asset the build ships but nothing can read. This
 * loads the real files, applies the real kit, and asks the one question that
 * matters: does a pad make a sound.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAudioFile } from './crate';
import { compileVoice } from '../../../src/asl/compile';
import { createDrumMaterial, liveDrumGraph } from './drumMaterial';
import { FACTORY_PAD_SAMPLES, applyFactoryKitParams } from './drumKit';
import { NUM_PADS, PAD_BASE_NOTE } from './drumParams';
import { setDrumPadAsset } from './drumPads';

const SR = 48000;

function assetBytes(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../assets/${filename}`, import.meta.url))));
}

/** The kit as the editor loads it: decoded once per file, shared across pads. */
function loadedDrum() {
  const material = createDrumMaterial({ sampleRate: SR });
  const decoded = new Map<string, ReturnType<typeof decodeAudioFile>>();
  FACTORY_PAD_SAMPLES.forEach((filename, pad) => {
    let buffer = decoded.get(filename);
    if (!buffer) {
      buffer = decodeAudioFile(assetBytes(filename), filename);
      decoded.set(filename, buffer);
    }
    setDrumPadAsset(material, pad, {
      filename,
      samples: buffer.getChannelData(0).slice(),
      sampleRate: buffer.sampleRate,
    });
  });
  applyFactoryKitParams(material);
  return material;
}

/** Exactly what `PatchAudio.triggerNode` sends, and nothing else. */
function strike(material: ReturnType<typeof createDrumMaterial>, pad: number, velocity: number, frames: number) {
  const voice = compileVoice(material.graph);
  const state = voice.createState();
  voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE + pad, velocity });
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  voice.renderBlock(state, SR, left, undefined, { outputR: right });
  let worst = 0;
  for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(left[i]!), Math.abs(right[i]!));
  return worst;
}

describe('the factory kit, played', () => {
  it('decodes every shipped sample', () => {
    const files = readdirSync(fileURLToPath(new URL('../assets', import.meta.url))).filter((name) =>
      name.endsWith('.wav'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const filename of files) {
      const buffer = decodeAudioFile(assetBytes(filename), filename);
      expect(buffer.sampleRate, `${filename} sample rate`).toBe(SR);
      expect(buffer.length, `${filename} is empty`).toBeGreaterThan(1000);
      let peak = 0;
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
      expect(peak, `${filename} is silent`).toBeGreaterThan(0.05);
    }
  });

  it('sounds every pad the kit gives a level to', () => {
    const material = loadedDrum();
    const silent: number[] = [];
    for (let pad = 0; pad < NUM_PADS; pad++) {
      if (material.getParam(`pad${pad}Vol`) === 0) continue;
      if (strike(material, pad, 0.85, 2048) < 1e-3) silent.push(pad);
    }
    expect(silent, 'pads that should sound and did not').toEqual([]);
  });

  it('is audible at the keybed default velocity, not just at full scale', () => {
    // The pad grid plays at whatever the Vel slider holds, which starts at
    // 0.85. A kit that only sounds at velocity 1 would be a kit that never
    // sounds.
    const material = loadedDrum();
    expect(strike(material, 0, 0.85, 2048)).toBeGreaterThan(0.01);
  });

  it('is silent before it is struck', () => {
    const material = loadedDrum();
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    const left = new Float32Array(512);
    const right = new Float32Array(512);
    voice.renderBlock(state, SR, left, undefined, { outputR: right });
    let worst = 0;
    for (let i = 0; i < 512; i++) worst = Math.max(worst, Math.abs(left[i]!), Math.abs(right[i]!));
    expect(worst).toBe(0);
  });

  it('still sounds a pad after Play auto-fires note 69, the way the editor arms sources', () => {
    const material = loadedDrum();
    const voice = compileVoice(material.graph);
    const state = voice.createState();
    const params = material.snapshotParams();
    voice.noteOn(state, { ...params, note: 69, velocity: 0.85 });
    const armed = new Float32Array(128);
    voice.renderBlock(state, SR, armed, undefined, { outputR: new Float32Array(128) });
    expect(peakOf(armed)).toBe(0);
    voice.noteOn(state, { ...params, note: PAD_BASE_NOTE, velocity: 0.85 });
    const struck = new Float32Array(2048);
    voice.renderBlock(state, SR, struck, undefined, { outputR: new Float32Array(2048) });
    expect(peakOf(struck)).toBeGreaterThan(0.01);
  });

  it('plays through the live graph faster than the audio it covers', () => {
    const material = loadedDrum();
    const voice = compileVoice(structuredClone(liveDrumGraph(material)));
    const state = voice.createState();
    voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 0.85 });
    const frames = 128;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < 4; i++) voice.renderBlock(state, SR, left, undefined, { outputR: right });
    const start = performance.now();
    const blocks = 48;
    for (let i = 0; i < blocks; i++) voice.renderBlock(state, SR, left, undefined, { outputR: right });
    const ms = performance.now() - start;
    const audioMs = (blocks * frames * 1000) / SR;
    expect(peakOf(left)).toBeGreaterThan(0.01);
    expect(ms, 'live graph slower than realtime').toBeLessThan(audioMs);
  });

  it('keeps pad samples after the structured clone a worklet uses', () => {
    const material = loadedDrum();
    const cloned = structuredClone(material.graph) as typeof material.graph;
    const tables: number[] = [];
    walkSampleTables(cloned.output, tables, new Set());
    expect(tables.filter((n) => n > 1000).length, 'cloned samplePlay tables that still hold audio').toBe(NUM_PADS);
    const voice = compileVoice(cloned);
    const state = voice.createState();
    voice.noteOn(state, { ...material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 0.85 });
    const left = new Float32Array(2048);
    voice.renderBlock(state, SR, left, undefined, { outputR: new Float32Array(2048) });
    expect(peakOf(left)).toBeGreaterThan(0.01);
  });
});

function peakOf(block: Float32Array): number {
  let worst = 0;
  for (const v of block) worst = Math.max(worst, Math.abs(v));
  return worst;
}

function walkSampleTables(
  node: { kind: string; id: number; params: Record<string, unknown>; inputs: Record<string, unknown>; list?: unknown[] },
  into: number[],
  seen: Set<number>,
): void {
  if (seen.has(node.id)) return;
  seen.add(node.id);
  if (node.kind === 'samplePlay') {
    const box = node.params.box as { samples?: { length?: number } } | undefined;
    const table = node.params.table as { length?: number } | undefined;
    into.push(box?.samples?.length ?? table?.length ?? 0);
  }
  for (const child of Object.values(node.inputs)) {
    if (child && typeof child === 'object' && 'kind' in child) {
      walkSampleTables(child as Parameters<typeof walkSampleTables>[0], into, seen);
    }
  }
  for (const child of node.list ?? []) {
    if (child && typeof child === 'object' && 'kind' in child) {
      walkSampleTables(child as Parameters<typeof walkSampleTables>[0], into, seen);
    }
  }
}
