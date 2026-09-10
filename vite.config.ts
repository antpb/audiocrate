import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Library build for the published package.
 *
 * ## Why several entries rather than one bundle
 *
 * Audiocrate's subpaths are not a convenience, they are a size contract. `theory`
 * is pure maths over note names and has no reason to pull in an interpreter;
 * `testing` exists to be imported by test files and should never reach a
 * production bundle. Building them as separate entries keeps that promise
 * legible in `dist/` rather than resting on a consumer's tree-shaker.
 *
 * ## Why `preserveModules`
 *
 * The alternative is one flattened file per entry, which is smaller to look
 * at and worse to use: a stack trace from inside a Material points at a line
 * number in a 20,000-line bundle, and a consumer's bundler loses the module
 * boundaries it needs to drop the two thirds of Audiocrate that a given app does
 * not touch. Preserving the module graph costs some bytes on disk and keeps
 * both of those.
 *
 * `dist/` therefore mirrors `src/`, which also means `dist/index.d.ts` from
 * `tsc` lands exactly beside the `dist/index.js` it describes.
 */
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    // The worklet build writes dist/crate-voice-processor.js first, and it is
    // not part of the module graph, so a clean here would delete it.
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'theory/index': resolve(__dirname, 'src/theory/index.ts'),
        'hooks/index': resolve(__dirname, 'src/hooks/index.ts'),
        'collab/index': resolve(__dirname, 'src/collab/index.ts'),
        'spatial/index': resolve(__dirname, 'src/spatial/index.ts'),
        'testing/index': resolve(__dirname, 'src/testing/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Node builtins are reachable only from `testing` (reading and writing
      // wav files from a test). Marking them external rather than polyfilled
      // keeps the browser entries free of shims and lets a bundler fail
      // loudly if one is ever imported from the audio path by mistake.
      external: [/^node:/],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
});
