import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { workletUrlStub } from '../vitest-worklet-stub';
import { optionalSiblingsPlugin } from './vite-optional-siblings';

const root = fileURLToPath(new URL('.', import.meta.url));
const crateRoot = resolve(root, '..');

function urlImportStub(): Plugin {
  return {
    name: 'url-import-stub',
    enforce: 'pre',
    resolveId(source) {
      return source.includes('?url') ? '\0url-import-stub' : null;
    },
    load(id) {
      return id === '\0url-import-stub' ? "export default 'stub-asset.url';" : null;
    },
  };
}

export default defineConfig({
  root,
  plugins: [workletUrlStub(), urlImportStub(), optionalSiblingsPlugin(crateRoot)],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
