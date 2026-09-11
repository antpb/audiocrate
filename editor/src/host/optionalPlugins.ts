import { registerHomecrateMaterials } from '../../../examples/homecrate/src/index';
import { setNamMaxFrames } from '../../../examples/amp/src/index';

export function registerOptionalMaterials(): void {
  registerHomecrateMaterials();
}

export function setOptionalNamMaxFrames(frames: number): void {
  setNamMaxFrames(frames);
}
