import { registerHomecrateMaterials } from '../../../../crate-homecrate/src/index';
import { setNamMaxFrames } from '../../../../crate-amp/src/index';

export function registerOptionalMaterials(): void {
  registerHomecrateMaterials();
}

export function setOptionalNamMaxFrames(frames: number): void {
  setNamMaxFrames(frames);
}
