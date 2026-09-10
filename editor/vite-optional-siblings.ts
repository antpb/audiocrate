import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export const SIBLING_PACKAGES = [
  'crate-amp',
  'crate-grain',
  'crate-synth',
  'crate-space-reverb',
  'crate-homecrate',
] as const;

export type SiblingName = (typeof SIBLING_PACKAGES)[number];

export function packagesDirFrom(crateRoot: string): string {
  return resolve(crateRoot, '..');
}

export function siblingRoot(crateRoot: string, name: SiblingName): string {
  return resolve(packagesDirFrom(crateRoot), name);
}

export function siblingExists(crateRoot: string, name: SiblingName): boolean {
  return existsSync(resolve(siblingRoot(crateRoot, name), 'src/index.ts'));
}

function tryFile(abs: string): string | null {
  if (existsSync(abs)) return abs;
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.wasm', '.nam']) {
    if (existsSync(abs + ext)) return abs + ext;
  }
  if (existsSync(resolve(abs, 'index.ts'))) return resolve(abs, 'index.ts');
  return null;
}

function siblingOf(abs: string, crateRoot: string): SiblingName | null {
  const packagesDir = packagesDirFrom(crateRoot);
  for (const name of SIBLING_PACKAGES) {
    const root = resolve(packagesDir, name);
    if (abs === root || abs.startsWith(root + sep)) return name;
  }
  return null;
}

const STUBS: Record<SiblingName, string> = {
  'crate-amp': [
    "export const AMP_ASSET = { nam: 'amp.nam', ir: 'amp.ir', namR: 'amp.namR', irR: 'amp.irR', irRef: 'amp.ir.ref' };",
    'export function ampNamAsset() { return undefined; }',
    'export function ampNamAssetR() { return undefined; }',
    'export function ampIrAsset() { return undefined; }',
    'export function setAmpNamAsset() {}',
    'export function setAmpNamAssetR() {}',
    'export function setNamMaxFrames() {}',
    "export function createAmpMaterial() { throw new Error('crate-amp is not in this checkout'); }",
    'export const HOMECRATE_AMP_MANUFACTURER = 0;',
    'export const HOMECRATE_AMP_SUBTYPE = 0;',
  ].join('\n'),
  'crate-grain': [
    "export function createGrainMaterial() { throw new Error('crate-grain is not in this checkout'); }",
    'export const HOMECRATE_GRAIN_MANUFACTURER = 0;',
    'export const HOMECRATE_GRAIN_SUBTYPE = 0;',
    "export const GRAIN_KERNEL_SLOT = 'homecrate.grain';",
  ].join('\n'),
  'crate-synth': [
    'export const HOMECRATE_SYNTH_MANUFACTURER = 0;',
    'export const HOMECRATE_SYNTH_SUBTYPE = 0;',
    "export const SYNTH_KERNEL_SLOT = 'homecrate.synth';",
  ].join('\n'),
  'crate-space-reverb': [
    "export const SPACE_REVERB_KERNEL_SLOT = 'homecrate.space-reverb';",
  ].join('\n'),
  'crate-homecrate': [
    'export function registerHomecrateMaterials() {}',
    "export const AMP_KERNEL_SLOT = 'homecrate.amp';",
    "export const GRAIN_KERNEL_SLOT = 'homecrate.grain';",
    "export const SYNTH_KERNEL_SLOT = 'homecrate.synth';",
    "export const SPACE_REVERB_KERNEL_SLOT = 'homecrate.space-reverb';",
  ].join('\n'),
};

export function optionalSiblingsPlugin(crateRoot: string): Plugin {
  return {
    name: 'optional-siblings',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const q = source.indexOf('?');
      const rel = q >= 0 ? source.slice(0, q) : source;
      const query = q >= 0 ? source.slice(q) : '';
      const abs = resolve(dirname(importer.split('?')[0]!), rel);
      const name = siblingOf(abs, crateRoot);
      if (!name) return null;
      if (tryFile(abs)) return null;
      if (query.includes('url') || abs.endsWith('.wasm') || abs.endsWith('.nam')) {
        return '\0optional-sibling-url';
      }
      return `\0optional-sibling:${name}`;
    },
    load(id) {
      if (id === '\0optional-sibling-url') return 'export default "";';
      if (id.startsWith('\0optional-sibling:')) {
        const name = id.slice('\0optional-sibling:'.length) as SiblingName;
        return STUBS[name] ?? 'export {};';
      }
      return null;
    },
  };
}
