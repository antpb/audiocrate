import type { AudioAssetData, AudioMaterial, SampleBox } from './crate';
import { NUM_PADS } from './drumParams';

/**
 * One sample buffer per pad, held beside the material.
 *
 * A `SampleBox` is the handle the `samplePlay` node reads through, so loading
 * a pad is a write into the box rather than a new graph. Pads are numbered,
 * holes and all: pad 7 loaded with 0 to 6 empty stays pad 7, because the pad
 * number is the MIDI note.
 */
const padBoxes = new WeakMap<AudioMaterial, SampleBox[]>();

export function drumPadKey(pad: number): string {
  return `drum.pad.${pad}`;
}

export function createPadBoxes(): SampleBox[] {
  return Array.from({ length: NUM_PADS }, () => ({ samples: new Float32Array(0), sampleRate: 48000 }));
}

export function attachPadBoxes(material: AudioMaterial, boxes: SampleBox[]): void {
  padBoxes.set(material, boxes);
}

export function drumPadBoxes(material: AudioMaterial): SampleBox[] | undefined {
  return padBoxes.get(material);
}

/** Copy decoded pad files into the playheads the live graph reads. */
export function ensureDrumPadBoxes(material: AudioMaterial): SampleBox[] {
  let boxes = padBoxes.get(material);
  if (!boxes) {
    boxes = createPadBoxes();
    attachPadBoxes(material, boxes);
  }
  for (let pad = 0; pad < NUM_PADS; pad++) {
    const asset = drumPadAsset(material, pad);
    if (asset && asset.samples.length >= 2) {
      boxes[pad]!.samples = asset.samples;
      boxes[pad]!.sampleRate = asset.sampleRate;
    }
  }
  return boxes;
}

export function setDrumPadAsset(material: AudioMaterial, pad: number, asset: AudioAssetData): void {
  material.setAsset(drumPadKey(pad), asset);
  const box = padBoxes.get(material)?.[pad];
  if (box) {
    box.samples = asset.samples;
    box.sampleRate = asset.sampleRate;
  }
}

export function clearDrumPadAsset(material: AudioMaterial, pad: number): void {
  material.clearAsset(drumPadKey(pad));
  const box = padBoxes.get(material)?.[pad];
  if (box) {
    box.samples = new Float32Array(0);
    box.sampleRate = 48000;
  }
}

export function drumPadAsset(material: AudioMaterial, pad: number): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(drumPadKey(pad));
}

/** Every loaded pad, sparse, in pad order. */
export function drumPadAssets(material: AudioMaterial): Array<AudioAssetData | undefined> {
  return Array.from({ length: NUM_PADS }, (_, pad) => drumPadAsset(material, pad));
}
