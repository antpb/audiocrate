import type { AudioAssetData, AudioMaterial } from './crate';

/**
 * The synth hosts several impulse responses at once, one per slot, so its
 * asset keys are indexed. Slot numbering is the preset's own and holes are
 * meaningful: slot 3 loaded with slots 0-2 empty must stay slot 3.
 */
export const SYNTH_IR_SLOT_COUNT = 6;

export function synthIrSlotKey(slot: number): string {
  return `synth.ir.${slot}`;
}

export function synthIrSlotAsset(material: AudioMaterial, slot: number): AudioAssetData | undefined {
  return material.getAsset<AudioAssetData>(synthIrSlotKey(slot));
}

export function setSynthIrSlotAsset(material: AudioMaterial, slot: number, asset: AudioAssetData): void {
  material.setAsset(synthIrSlotKey(slot), asset);
}

/** Every loaded slot, sparse, in slot order. */
export function synthIrSlots(material: AudioMaterial): Array<AudioAssetData | undefined> {
  return Array.from({ length: SYNTH_IR_SLOT_COUNT }, (_, slot) => synthIrSlotAsset(material, slot));
}
