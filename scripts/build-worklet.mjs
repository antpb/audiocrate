/**
 * Bundles crate's voice worklet into a form a published package can deliver.
 *
 * ## Why this exists
 *
 * An `AudioWorkletProcessor` runs in a context with no imports and no network.
 * It has to arrive as one self-contained script, fetched from a URL. Every
 * bundler solves that with its own private syntax: Vite has `?worklet` and
 * `?url`, webpack has `new Worker(new URL(...))` heuristics, esbuild has
 * `loader: file`. A library that picks one of them picks its users' bundler
 * for them.
 *
 * Audiocrate used to import `'./crate-voice-processor.ts?worklet'`, which meant
 * installing Audiocrate from npm and building with anything other than Vite plus a
 * specific local plugin failed to resolve at build time. That is fine for an
 * app inside this repo and disqualifying for a published package.
 *
 * So the worklet is bundled here, ahead of time, into two artifacts:
 *
 * 1. **`src/renderers/worklet/bundled.generated.ts`** exports the bundle as a
 *    string. `crateWorkletUrls()` turns it into blob and data URLs at runtime.
 *    This is the default path and it needs nothing from the host's bundler:
 *    it is an ordinary string constant in an ordinary module.
 * 2. **`dist/crate-voice-processor.js`** is the same bundle as a file,
 *    for a host that would rather serve it as a cacheable asset and pass its
 *    URL in. Nothing requires this; it is there because a separate file is
 *    genuinely better when you can serve one, and it is readable in devtools.
 *
 * ## The staleness problem
 *
 * A generated file checked into source control is a file that can silently
 * describe the previous version of the code. That failure is quiet and it
 * lands as "my DSP fix did nothing". `bundledWorklet.test.ts` regenerates the
 * bundle and compares, so the test suite fails rather than the user.
 *
 * ## Not minified
 *
 * Deliberately. A worklet is the hardest place in a web app to debug: no
 * breakpoints worth the name, errors that surface as silence, and a hard
 * realtime deadline. Readable frames are worth more than the bytes, and gzip
 * takes the bundle to roughly a quarter of its size anyway. A host that wants
 * it smaller can minify its own entry and pass the URL.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');

export const WORKLET_ENTRY = resolve(pkg, 'src/renderers/worklet/crate-voice-processor.ts');
export const GENERATED_TS = resolve(pkg, 'src/renderers/worklet/bundled.generated.ts');
export const DIST_JS = resolve(pkg, 'dist/crate-voice-processor.js');

/** Bundles the worklet entry and returns the JavaScript as a string. */
export async function bundleWorklet() {
  const result = await build({
    entryPoints: [WORKLET_ENTRY],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    // The worklet realm has no `module`, and nothing in the DSP path wants it.
    // Anything that reaches for it is a bundler artifact, not crate code.
    plugins: [
      {
        name: 'stub-node-builtins',
        setup(b) {
          b.onResolve({ filter: /^(module|node:module)$/ }, () => ({
            path: 'stub',
            namespace: 'crate-stub',
          }));
          b.onLoad({ filter: /.*/, namespace: 'crate-stub' }, () => ({
            contents: 'export default {};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('crate: the worklet bundle produced no output');
  return file.text;
}

/**
 * The exact text of `bundled.generated.ts` for a given bundle.
 *
 * Shared with the staleness test so that "is the checked-in file current"
 * compares whole files rather than trying to parse the string back out.
 */
export function renderGeneratedModule(source) {
  return [
    '/**',
    ' * GENERATED FILE. Do not edit.',
    ' *',
    " * Rebuild with `npm run build:worklet` from this package. `bundledWorklet.test.ts`",
    ' * fails if this file does not match what the current sources bundle to, so a',
    ' * stale copy is a red test rather than a DSP change that appears to do nothing.',
    ' *',
    ' * This is crate\'s AudioWorklet processor: the ASL interpreter, the core kernels,',
    ' * and the message protocol, bundled into one self-contained ES module. It is a',
    ' * string rather than a file so that installing crate from npm requires no',
    ' * bundler plugin and no build step. See `scripts/build-worklet.mjs`.',
    ' *',
    ' * It is reachable only from `WebAudioRenderer`, so a host that never plays audio',
    ' * in real time (offline rendering, analysis, the theory package) tree-shakes it',
    ' * away entirely.',
    ' */',
    '',
    '/** The bundled worklet module, ready to hand to `audioWorklet.addModule`. */',
    `export const CRATE_WORKLET_SOURCE = ${JSON.stringify(source)};`,
    '',
  ].join('\n');
}

/** True when the checked-in generated module already matches `source`. */
export async function generatedIsCurrent(source) {
  try {
    const onDisk = await readFile(GENERATED_TS, 'utf8');
    return onDisk === renderGeneratedModule(source);
  } catch {
    return false;
  }
}

async function main() {
  const source = await bundleWorklet();
  await writeFile(GENERATED_TS, renderGeneratedModule(source), 'utf8');
  await mkdir(dirname(DIST_JS), { recursive: true });
  await writeFile(DIST_JS, source, 'utf8');
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  process.stdout.write(
    `crate worklet: ${kb(source.length)}\n` +
      `  src/renderers/worklet/bundled.generated.ts (inlined as a string)\n` +
      `  dist/crate-voice-processor.js (standalone asset)\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
