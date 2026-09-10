import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const HAS_AMP = existsSync(resolve(packagesDir, 'crate-amp/src/index.ts'));
export const HAS_GRAIN = existsSync(resolve(packagesDir, 'crate-grain/src/index.ts'));
export const HAS_HOMECRATE = existsSync(resolve(packagesDir, 'crate-homecrate/src/index.ts'));
