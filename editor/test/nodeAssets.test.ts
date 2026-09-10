import { describe, expect, it } from 'vitest';
import { HAS_AMP } from './siblings';
import {
  createIrMaterial,
  createSamplePlayerMaterial,
  createWavetableMaterial,
  decodeAudioFile,
  irAsset,
  sampleAsset,
  wavetableAsset,
  wavetableBank,
} from '../../src/index';
import { ampIrAsset, ampNamAsset, createAmpMaterial } from '../../../crate-amp/src/index';
import {
  applyIr,
  applyNam,
  applyNamR,
  applySample,
  applyWavetable,
  clearIr,
  clearNam,
  clearNamR,
  clearSample,
  clearWavetable,
  decodeIrBytes,
  hasFileSlots,
  irFilename,
  namFilename,
  namFilenameR,
  parseNamText,
  sampleFilename,
  wavetableFilename,
} from '../src/nodeAssets';

describe('nodeAssets', () => {
  it('accepts a NAM-shaped JSON object', () => {
    const asset = parseNamText('{"version":1,"architecture":"LSTM"}', 'demo.nam');
    expect(asset.filename).toBe('demo.nam');
    expect(asset.json).toContain('LSTM');
  });

  it('rejects non-JSON and non-object NAM files', () => {
    expect(() => parseNamText('not json', 'bad.nam')).toThrow(/not valid JSON/);
    expect(() => parseNamText('[]', 'list.nam')).toThrow(/not a NAM profile/);
    expect(() => parseNamText('4', 'n.nam')).toThrow(/not a NAM profile/);
  });

  it.skipIf(!HAS_AMP)('attaches and clears an amp profile, and ignores a cabinet on Amp', () => {
    const amp = createAmpMaterial();
    applyNam(amp, { filename: 'a.nam', json: '{"ok":true}' });
    expect(namFilename(amp)).toBe('a.nam');
    expect(ampNamAsset(amp)?.json).toContain('ok');
    applyNamR(amp, { filename: 'b.nam', json: '{"right":true}' });
    expect(namFilenameR(amp)).toBe('b.nam');
    clearNamR(amp);
    expect(namFilenameR(amp)).toBeNull();
    expect(namFilename(amp)).toBe('a.nam');
    applyIr(amp, 'amp', { filename: 'cab.wav', samples: new Float32Array([1, 0, 0.5]), sampleRate: 48000 });
    expect(irFilename(amp, 'amp')).toBeNull();
    expect(ampIrAsset(amp)).toBeUndefined();
    clearNam(amp);
    expect(namFilename(amp)).toBeNull();
  });

  it('attaches an impulse on the IR material', () => {
    const ir = createIrMaterial();
    applyIr(ir, 'ir', { filename: 'room.wav', samples: new Float32Array([0.2]), sampleRate: 44100 });
    expect(irFilename(ir, 'ir')).toBe('room.wav');
    expect(irAsset(ir)?.sampleRate).toBe(44100);
    clearIr(ir, 'ir');
    expect(irAsset(ir)).toBeUndefined();
  });

  it('decodes a tiny WAV without a browser AudioContext', async () => {
    const frames = [
      [0.25],
      [-0.5],
      [0.1],
    ];
    const wav = buildFloatWav(frames, 48000);
    const asset = await decodeIrBytes(wav, 'click.wav', null);
    expect(asset.filename).toBe('click.wav');
    expect(asset.sampleRate).toBe(48000);
    expect(asset.samples.length).toBe(3);
    expect(decodeAudioFile(wav, 'click.wav').length).toBe(3);
  });

  it('attaches and clears a sample on Sample Player', () => {
    const player = createSamplePlayerMaterial();
    applySample(player, { filename: 'hit.wav', samples: new Float32Array([0.4, 0.1]), sampleRate: 44100 });
    expect(sampleFilename(player)).toBe('hit.wav');
    expect(sampleAsset(player)?.sampleRate).toBe(44100);
    clearSample(player);
    expect(sampleFilename(player)).toBeNull();
    expect(sampleAsset(player)).toBeUndefined();
  });

  it('attaches and clears a table on Wavetable', () => {
    const table = createWavetableMaterial();
    const factory = wavetableBank();
    applyWavetable(table, { filename: 'bank.wav', samples: new Float32Array([0.2, -0.1]), sampleRate: 48000 });
    expect(wavetableFilename(table)).toBe('bank.wav');
    expect(wavetableAsset(table)?.sampleRate).toBe(48000);
    clearWavetable(table);
    expect(wavetableFilename(table)).toBeNull();
    expect(wavetableAsset(table)).toBeUndefined();
    expect(factory.length).toBeGreaterThan(2);
  });

  it('only offers file slots on amp, ir, sampleplayer, and wavetable', () => {
    expect(hasFileSlots('amp')).toBe(true);
    expect(hasFileSlots('ir')).toBe(true);
    expect(hasFileSlots('sampleplayer')).toBe(true);
    expect(hasFileSlots('wavetable')).toBe(true);
    expect(hasFileSlots('spacereverb')).toBe(false);
    expect(hasFileSlots(null)).toBe(false);
  });
});

function buildFloatWav(frames: number[][], sampleRate: number): Uint8Array {
  const channels = 1;
  const dataBytes = frames.length * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  frames.forEach((frame, index) => view.setFloat32(44 + index * 4, frame[0]!, true));
  return new Uint8Array(buffer);
}
