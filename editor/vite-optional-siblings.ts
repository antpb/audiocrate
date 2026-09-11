import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export const EXAMPLE_PACKAGES = [
  'amp',
  'grain',
  'synth',
  'space-reverb',
  'homecrate',
] as const;

export type ExampleName = (typeof EXAMPLE_PACKAGES)[number];

export function examplesDirFrom(crateRoot: string): string {
  return resolve(crateRoot, 'examples');
}

export function exampleRoot(crateRoot: string, name: ExampleName): string {
  return resolve(examplesDirFrom(crateRoot), name);
}

export function exampleExists(crateRoot: string, name: ExampleName): boolean {
  return existsSync(resolve(exampleRoot(crateRoot, name), 'src/index.ts'));
}

function tryFile(abs: string): string | null {
  if (existsSync(abs)) return abs;
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.wasm', '.nam']) {
    if (existsSync(abs + ext)) return abs + ext;
  }
  if (existsSync(resolve(abs, 'index.ts'))) return resolve(abs, 'index.ts');
  return null;
}

function exampleOf(abs: string, crateRoot: string): ExampleName | null {
  const examplesDir = examplesDirFrom(crateRoot);
  for (const name of EXAMPLE_PACKAGES) {
    const root = resolve(examplesDir, name);
    if (abs === root || abs.startsWith(root + sep)) return name;
  }
  return null;
}

const STUBS: Record<ExampleName, string> = {
  amp: [
    "export const AMP_ASSET = { nam: 'amp.nam', ir: 'amp.ir', namR: 'amp.namR', irR: 'amp.irR', irRef: 'amp.ir.ref' };",
    'export function ampNamAsset() { return undefined; }',
    'export function ampNamAssetR() { return undefined; }',
    'export function ampIrAsset() { return undefined; }',
    'export function setAmpNamAsset() {}',
    'export function setAmpNamAssetR() {}',
    'export function setNamMaxFrames() {}',
    "export function createAmpMaterial() { throw new Error('examples/amp is not in this checkout'); }",
    'export const HOMECRATE_AMP_MANUFACTURER = 0;',
    'export const HOMECRATE_AMP_SUBTYPE = 0;',
  ].join('\n'),
  grain: [
    "export function createGrainMaterial() { throw new Error('examples/grain is not in this checkout'); }",
    'export const HOMECRATE_GRAIN_MANUFACTURER = 0;',
    'export const HOMECRATE_GRAIN_SUBTYPE = 0;',
    "export const GRAIN_KERNEL_SLOT = 'homecrate.grain';",
  ].join('\n'),
  synth: [
    'export const HOMECRATE_SYNTH_MANUFACTURER = 0;',
    'export const HOMECRATE_SYNTH_SUBTYPE = 0;',
    "export const SYNTH_KERNEL_SLOT = 'homecrate.synth';",
  ].join('\n'),
  'space-reverb': [
    "export const SPACE_REVERB_KERNEL_SLOT = 'homecrate.space-reverb';",
  ].join('\n'),
  homecrate: [
    'export function registerHomecrateMaterials() {}',
    "export const AMP_KERNEL_SLOT = 'homecrate.amp';",
    "export const GRAIN_KERNEL_SLOT = 'homecrate.grain';",
    "export const SYNTH_KERNEL_SLOT = 'homecrate.synth';",
    "export const SPACE_REVERB_KERNEL_SLOT = 'homecrate.space-reverb';",
  ].join('\n'),
};

export function optionalSiblingsPlugin(crateRoot: string): Plugin {
  return {
    name: 'optional-examples',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const q = source.indexOf('?');
      const rel = q >= 0 ? source.slice(0, q) : source;
      const query = q >= 0 ? source.slice(q) : '';
      const abs = resolve(dirname(importer.split('?')[0]!), rel);
      const name = exampleOf(abs, crateRoot);
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
        const name = id.slice('\0optional-sibling:'.length) as ExampleName;
        return STUBS[name] ?? 'export {};';
      }
      return null;
    },
  };
}
