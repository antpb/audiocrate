// Bundles and runs emit-factory-compiled.ts.
//
// The editor's catalog imports its kernel assets with Vite's `?url` suffix,
// which esbuild has no loader for. None of those assets reach a compiled
// factory patch (flatten refuses kernels, and no factory patch holds a
// file), so each one resolves to a placeholder string here.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? resolve(here, '../build/factory-compiled.json');
const bundle = resolve(here, '../build/emit-factory-compiled.bundle.mjs');

const urlStub = {
  name: 'url-stub',
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: 'url-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'url-stub' }, () => ({ contents: 'export default "asset://unused"', loader: 'js' }));
  },
};

await build({
  entryPoints: [resolve(here, 'emit-factory-compiled.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
  plugins: [urlStub],
});
execFileSync(process.execPath, [bundle, out], { stdio: 'inherit' });
