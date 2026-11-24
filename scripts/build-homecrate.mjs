/**
 * Builds the `audiocrate/homecrate` entry: homecrate's plugins (amp, drum,
 * grain, synth, space reverb), the worklet with their kernels compiled in,
 * and the WASM those kernels load.
 *
 *   dist/homecrate/index.js            registerHomecrateMaterials, the plugins,
 *                                      HOMECRATE_KERNEL_FILES, loadHomecrateKernelBinaries
 *   dist/homecrate/index.d.ts
 *   dist/homecrate/voice-processor.js  the worklet: crate's processor plus the kernels
 *   dist/homecrate/wasm/*.wasm
 *
 * The plugins live in `examples/`, outside `src/`, so they are bundled here
 * rather than by the library build. Core is not bundled into the entry: every
 * import of `src/index` becomes `../index.js`, so a host that imports both
 * `audiocrate` and `audiocrate/homecrate` gets one registry, one class of
 * every material, and one copy of core. The worklet is the opposite: an
 * AudioWorklet cannot import, so it is one self-contained file.
 *
 * Runs after `vite build` (it writes into dist/ beside it).
 */
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const out = resolve(pkg, 'dist/homecrate');
const coreIndex = resolve(pkg, 'src/index.ts');

// The worklet realm has no `module`; same stub as scripts/build-worklet.mjs.
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(b) {
    b.onResolve({ filter: /^(module|node:module)$/ }, () => ({ path: 'stub', namespace: 'crate-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'crate-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

const coreExternal = {
  name: 'audiocrate-core-external',
  setup(b) {
    b.onResolve({ filter: /\/src\/index$/ }, (args) => {
      const target = resolve(args.resolveDir, args.path);
      if (`${target}.ts` === coreIndex || target === coreIndex) return { path: '../index.js', external: true };
      return undefined;
    });
  },
};

async function main() {
  await mkdir(resolve(out, 'wasm'), { recursive: true });

  await build({
    entryPoints: [resolve(pkg, 'examples/homecrate/src/index.ts')],
    outfile: resolve(out, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    legalComments: 'none',
    plugins: [coreExternal, stubNodeBuiltins],
    logLevel: 'warning',
  });

  await build({
    entryPoints: [resolve(pkg, 'examples/homecrate/worklet/homecrate-voice-processor.ts')],
    outfile: resolve(out, 'voice-processor.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    plugins: [stubNodeBuiltins],
    logLevel: 'warning',
  });

  const copied = [];
  for (const dir of [
    ...['amp', 'drum', 'grain', 'synth', 'space-reverb', 'dyneq'].map((example) => resolve(pkg, `examples/${example}/wasm/dist`)),
    // CrateC, built by examples/CrateC/web/build.sh.
    resolve(pkg, 'examples/CrateC/web/dist'),
  ]) {
    if (!(await readdir(dir).catch(() => null))?.some((name) => name.endsWith('.wasm'))) {
      throw new Error(`no WASM in ${dir}: build it first (examples/CrateC/web/build.sh for CrateC)`);
    }
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.wasm')) continue;
      await copyFile(resolve(dir, name), resolve(out, 'wasm', name));
      copied.push(name);
    }
  }

  // Hand-written: the entry's surface is small, and tsc would have to follow
  // the examples' relative imports of src/ into a second copy of core's types.
  await writeFile(
    resolve(out, 'index.d.ts'),
    `import type { AudioMaterialPlugin, AudioMaterialRegistry, KernelBinaryMap } from '../index.js';

export declare const ampPlugin: AudioMaterialPlugin;
export declare const drumPlugin: AudioMaterialPlugin;
export declare const grainPlugin: AudioMaterialPlugin;
export declare const synthPlugin: AudioMaterialPlugin;
export declare const spaceReverbPlugin: AudioMaterialPlugin;
export declare const homecrateMaterials: readonly AudioMaterialPlugin[];
export declare const AMP_KERNEL_SLOT: string;
export declare const GRAIN_KERNEL_SLOT: string;
export declare const SYNTH_KERNEL_SLOT: string;
export declare const SPACE_REVERB_KERNEL_SLOT: string;
export declare const CRATE_KERNEL_SLOT: string;
export declare const DYNEQ_KERNEL_SLOT: string;
/** hc_dynEQ (5-band dynamic EQ + compressor, WASM) and hc_send. */
export declare const dyneqPlugin: AudioMaterialPlugin;
export declare const sendPlugin: AudioMaterialPlugin;
/**
 * Tracks whose dynEQ and hc_send share the envelope bus, which lives in one
 * audio realm: play these live together (not rendered ahead separately).
 * Empty when the scene has no hc_send.
 */
export declare function envelopeBusTracks<T extends { materials: { list: readonly { kind: string }[] } }>(tracks: readonly T[]): Set<T>;
/** The crate AU played live by CrateC (WASM); replace core's ASL crate plugins. */
export declare const crateInstrumentPlugin: AudioMaterialPlugin;
export declare const crateEffectPlugin: AudioMaterialPlugin;
/** The kernel slots a scene's materials need, for loadHomecrateKernelBinaries. */
export declare function homecrateKernelSlots(scene: {
  tracks: readonly { instrument?: { kind: string } | null; materials: { list: readonly { kind: string }[] } }[];
  master: { materials: { list: readonly { kind: string }[] } };
}): string[];
/** Registers core's plugins (IR, the crate AU) and homecrate's. Idempotent. */
export declare function registerHomecrateMaterials(registry?: AudioMaterialRegistry): AudioMaterialRegistry;
/** Kernel slot to the WASM file it loads, served from audiocrate/homecrate/wasm/. */
export declare const HOMECRATE_KERNEL_FILES: Readonly<Record<string, string>>;
/** Fetches the kernels for scene.prepareLiveVoices(renderer, binaries). */
export declare function loadHomecrateKernelBinaries(baseUrl: string, only?: readonly string[]): Promise<KernelBinaryMap>;
`,
    'utf8',
  );

  process.stdout.write(`homecrate: dist/homecrate/{index.js, voice-processor.js, wasm/${copied.join(', ')}}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
