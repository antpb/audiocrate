import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples');

export const HAS_AMP = existsSync(resolve(examplesDir, 'amp/src/index.ts'));
export const HAS_GRAIN = existsSync(resolve(examplesDir, 'grain/src/index.ts'));
export const HAS_HOMECRATE = existsSync(resolve(examplesDir, 'homecrate/src/index.ts'));
