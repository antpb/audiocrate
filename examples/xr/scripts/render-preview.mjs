/**
 * Bundles and runs `preview.ts`.
 *
 * The indirection exists because crate's barrel exports `WebAudioRenderer`,
 * which imports its own worklet URL through Vite's `?worklet` suffix. Nothing
 * in an offline render ever constructs that renderer, but esbuild still has
 * to resolve the import, so it gets stubbed the same way vitest and the
 * worklet's own build stub it.
 *
 *   node scripts/render-preview.mjs out.wav
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? 'resonant-stones.wav');
const bundle = resolve(here, '../node_modules/.crate-xr-preview.mjs');

await build({
  entryPoints: [resolve(here, 'preview.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundle,
  logLevel: 'error',
  plugins: [
    {
      name: 'stub-worklet-url',
      setup(b) {
        b.onResolve({ filter: /\?worklet$/ }, (args) => ({ path: args.path, namespace: 'worklet-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'worklet-stub' }, () => ({
          contents: "export default 'about:blank';",
          loader: 'js',
        }));
      },
    },
  ],
});

const { pathToFileURL } = await import('node:url');
process.argv[2] = out;
await import(pathToFileURL(bundle).href);
