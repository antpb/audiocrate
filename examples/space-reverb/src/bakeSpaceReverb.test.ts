import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bakeTrackInserts, Clip, AudioMaterialRegistry, Time, Track, type AudioBufferLike } from './crate';
import { createSpaceReverbMaterial } from './spaceReverbMaterial';
import { spaceReverbPlugin } from './plugin';
import { SPACE_REVERB_KERNEL_SLOT } from './kernelSlot';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../wasm/dist/space_reverb.wasm');
const SR = 48000;
const registry = new AudioMaterialRegistry().register(spaceReverbPlugin);

function trackWithClip(buffer: AudioBufferLike): Track {
  const track = new Track({ name: 'T' });
  track.addClip(new Clip({ buffer }), { at: Time.seconds(0) });
  return track;
}

function monoBuffer(samples: Float32Array | number[]): AudioBufferLike {
  const data = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  return { sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}

describe('space reverb on bakeTrackInserts', () => {
  it('is a dry copy when wasm is missing', async () => {
    const reverb = createSpaceReverbMaterial();
    reverb.setParam('reverbBlend', 0.8);
    const track = trackWithClip(monoBuffer([0.1, -0.2, 0.3, -0.4]));
    track.materials.add(reverb);

    const baked = await bakeTrackInserts([track], { registry });
    const data = baked.get(track.clips[0]!.clip.id)!.getChannelData(0);
    expect(Array.from(data)).toEqual([0.1, -0.2, 0.3, -0.4].map((sample) => expect.closeTo(sample, 5)));
  });

  it('runs Costello when the binary is present', async () => {
    const wasm = new Uint8Array(await readFile(wasmPath)) as unknown as ArrayBuffer;
    const reverb = createSpaceReverbMaterial();
    reverb.setParam('reverbBlend', 0.7);
    reverb.setParam('reverbDecay', 0.85);

    const input = new Float32Array(512);
    for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const track = trackWithClip(monoBuffer(input));
    track.materials.add(reverb);

    const dry = await bakeTrackInserts([track], { registry });
    const wet = await bakeTrackInserts([track], {
      registry,
      binaries: { [SPACE_REVERB_KERNEL_SLOT]: wasm },
    });

    const clipId = track.clips[0]!.clip.id;
    const dryData = dry.get(clipId)!.getChannelData(0);
    const wetData = wet.get(clipId)!.getChannelData(0);
    let differs = false;
    for (let i = 0; i < wetData.length; i++) {
      expect(Number.isFinite(wetData[i])).toBe(true);
      if (Math.abs(wetData[i]! - dryData[i]!) > 1e-4) differs = true;
    }
    expect(differs).toBe(true);
  });
});
