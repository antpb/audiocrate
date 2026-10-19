import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crateVoiceWorkletPlugin } from '../../../../vite-crate-worklet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the resonance-stage XR Publisher plugin as one file.
 *
 * The worklet is inlined (see `vite.config.ts` in this directory) because an
 * XR Publisher plugin is a single `.umd.js` dropped flat into a worlds API.
 * This config builds only the concert; `vite.config.ts` builds crate-stones.
 * Both reuse the same inlined worklet and the same `CrateAudio` bridge.
 *
 * `resonance.ts` is an untyped port of a legacy `.js` plugin that runs against
 * `window.XRPublisher` / `window.THREE` globals, so it is excluded from
 * `tsc --noEmit` and transpiled by Vite (esbuild) like any `.js` file. The
 * crate-native half it imports (`resonanceAudio.ts`) is fully typed.
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
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: path.resolve(__dirname, 'src/resonance.ts'),
      name: 'ResonanceStagePlugin',
      formats: ['umd'],
      fileName: () => 'resonance-stage-xr-publisher-plugin.umd.js',
    },
  },
});
