import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { optionalSiblingsPlugin, siblingExists, siblingRoot } from './vite-optional-siblings';
import { crateVoiceWorkletPlugin } from './vite-worklet-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const crateRoot = path.resolve(__dirname, '..');
const homecrateWorklet = path.resolve(siblingRoot(crateRoot, 'crate-homecrate'), 'worklet/homecrate-voice-processor.ts');
const crateWorklet = path.resolve(crateRoot, 'src/renderers/worklet/crate-voice-processor.ts');
const workletEntry = existsSync(homecrateWorklet) ? homecrateWorklet : crateWorklet;

const allow = [crateRoot];
for (const name of ['crate-amp', 'crate-grain', 'crate-synth', 'crate-space-reverb', 'crate-homecrate'] as const) {
  if (siblingExists(crateRoot, name)) allow.push(siblingRoot(crateRoot, name));
}

export default defineConfig({
  root: __dirname,
  base: process.env.CRATE_PATCHER_BASE || '/',
  server: { port: 5175, strictPort: true, fs: { allow } },
  assetsInclude: ['**/*.wasm', '**/*.nam'],
  plugins: [react(), optionalSiblingsPlugin(crateRoot), crateVoiceWorkletPlugin(workletEntry)],
  define: { global: 'globalThis' },
  optimizeDeps: {
    include: ['p2pcf'],
    esbuildOptions: { define: { global: 'globalThis' } },
  },
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
});
