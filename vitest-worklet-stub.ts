import type { Plugin } from 'vite';

/**
 * Resolves `...?worklet` imports to a plain URL string under vitest.
 *
 * `WebAudioRenderer` imports its default worklet as `...crate-voice-processor.ts?worklet`,
 * which the real build turns into a URL via `vite-crate-worklet.ts`. Vitest has
 * no such plugin, so without this it resolves the *source* module and executes
 * it in Node, where `AudioWorkletProcessor` does not exist. The failure lands
 * on whatever test happened to import crate's barrel, which is a confusing
 * place to see it.
 *
 * Stubbing the URL is the honest fix: a Node test can never load a worklet
 * anyway, and the worklet's own behavior is verified in browser by the
 * Playwright checks.
 */
export function workletUrlStub(): Plugin {
  const VIRTUAL = '\0crate-worklet-url-stub';
  return {
    name: 'crate-worklet-url-stub',
    enforce: 'pre',
    resolveId(source) {
      return source.endsWith('?worklet') ? VIRTUAL : null;
    },
    load(id) {
      return id === VIRTUAL ? "export default 'crate-voice-processor.worklet.js';" : null;
    },
  };
}
