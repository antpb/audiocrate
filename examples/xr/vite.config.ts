import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crateVoiceWorkletPlugin } from '../../../../vite-crate-worklet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the XR Publisher plugin as one file.
 *
 * Two things make this different from crate's other bundles.
 *
 * **The worklet is inlined.** An XR Publisher plugin is a single `.umd.js`
 * dropped flat into a worlds API; there is no way to publish a sibling asset
 * and no stable URL to fetch one from. `inline: true` turns crate's worklet
 * into a blob URL minted inside the bundle, so the DSP travels with the
 * plugin that needs it.
 *
 * **Audiocrate's own worklet entry, not homecrate's.** Pure ASL plus the core
 * convolver, no amp, grain or synth kernels. That is not a limitation here,
 * it is the demonstration: the AudioMaterial this plugin ships needs no kernel at
 * all, which is true of 107 of the 108 Materials crate ships.
 *
 * Three is not bundled and must not be: the engine's copy is already on the
 * page as `window.THREE`, and a second one breaks `instanceof` and doubles
 * the payload. This package has no three import to exclude, which is why
 * `CrateAudio` describes the shapes it needs structurally.
 */
export default defineConfig({
  plugins: [
    crateVoiceWorkletPlugin(
      path.resolve(__dirname, '../../../src/renderers/worklet/crate-voice-processor.ts'),
      { inline: true },
    ),
  ],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: path.resolve(__dirname, 'src/plugin.ts'),
      name: 'CrateStonesPlugin',
      formats: ['umd'],
      // The engine's uploader finds plugins with
      // `readdirSync('plugins').filter(f => f.endsWith('-xr-publisher-plugin.umd.js'))`,
      // so the suffix is load-bearing, not decoration.
      fileName: () => 'crate-stones-xr-publisher-plugin.umd.js',
    },
  },
});
