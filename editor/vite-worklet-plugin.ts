import type { Plugin } from 'vite';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const VIRTUAL = '\0crate-voice-worklet';

interface WorkletBundle {
  code: string;
  /** Absolute path of every source that went into the bundle, from esbuild's metafile. */
  inputs: Set<string>;
}

async function bundleWorklet(entry: string): Promise<WorkletBundle> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    plugins: [
      {
        name: 'stub-node-module',
        setup(b) {
          b.onResolve({ filter: /^module$/ }, () => ({ path: 'module', namespace: 'node-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
            contents: 'export default {};',
            loader: 'js',
          }));
        },
      },
      {
        // A host's worklet entry reaches crate's barrel (through its plugin
        // packages' Materials), and the barrel exports `WebAudioRenderer`,
        // which imports its own worklet URL. Bundling the worklet would then
        // recurse into bundling the worklet. Stub the URL: a worklet never
        // constructs a renderer, and this file *is* the thing that URL points
        // at.
        name: 'stub-worklet-url',
        setup(b) {
          b.onResolve({ filter: /\?worklet$/ }, (args) => ({
            path: args.path,
            namespace: 'worklet-url-stub',
          }));
          b.onLoad({ filter: /.*/, namespace: 'worklet-url-stub' }, () => ({
            contents: "export default '/crate-voice-processor.worklet.js';",
            loader: 'js',
          }));
        },
      },
    ],
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('crate worklet bundle produced no output');
  const inputs = new Set(Object.keys(result.metafile?.inputs ?? {}).map((path) => resolve(path)));
  return { code: file.text, inputs };
}

export interface CrateVoiceWorkletOptions {
  /**
   * Emit the worklet as a string inside the bundle and hand back a Blob URL,
   * instead of writing it out as a separate asset file.
   *
   * For a host that must ship as **one file**. An XR Publisher plugin is a
   * single `.umd.js` dropped into a worlds API, with no way to publish a
   * sibling asset and no stable URL to fetch one from, so a second file is
   * not a deployment inconvenience there, it is a plugin that cannot load its
   * own DSP. `audioWorklet.addModule` accepts a blob: URL, which makes the
   * whole worklet travel inside the bundle it belongs to.
   *
   * Off by default. A separate asset is cacheable, readable in devtools, and
   * does not cost a copy of the source in the main bundle, so it stays the
   * right answer whenever a host can serve two files.
   */
  inline?: boolean;
}

export function crateVoiceWorkletPlugin(entry: string, options: CrateVoiceWorkletOptions = {}): Plugin {
  let cached: WorkletBundle | null = null;
  let assetPrefix = '';
  const bundle = async () => {
    if (!cached) cached = await bundleWorklet(entry);
    return cached;
  };

  return {
    name: 'crate-voice-worklet',
    enforce: 'pre',

    /**
     * The worklet is bundled by a separate esbuild pass, so Vite's module
     * graph knows nothing about its sources and will not invalidate it. Left
     * alone, that means every DSP edit appears to do nothing until the dev
     * server is restarted, and worse, a browser check run against the stale
     * bundle passes while testing the previous version of the code.
     *
     * esbuild's metafile lists exactly what went into the bundle, so an edit
     * to any of those files drops the cache. A full reload rather than an HMR
     * update because `audioWorklet.addModule` is one-way: a running worklet
     * cannot be handed new code.
     */
    configResolved(config) {
      const base = config.base === '/' ? '' : (config.base ?? '').replace(/\/$/, '');
      assetPrefix = base;
    },

    handleHotUpdate({ file, server }) {
      if (!cached?.inputs.has(file)) return;
      cached = null;
      server.ws.send({ type: 'full-reload' });
    },

    async configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/crate-voice-processor.worklet.js') {
          next();
          return;
        }
        const { code } = await bundle();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(code);
      });
    },
    resolveId(source) {
      if (source.includes('?worklet') && source.includes('crate-voice-processor')) {
        return VIRTUAL;
      }
      return null;
    },
    async load(id) {
      if (id !== VIRTUAL && !id.includes('crate-voice-processor.ts?worklet')) return null;
      if (options.inline) {
        // Built in both dev and build: an inline host has no dev-server
        // middleware to fall back on, because the whole point is that it does
        // not serve its own files.
        const { code } = await bundle();
        // **Several URLs, not one.** `audioWorklet.addModule` is one of the
        // less uniform corners of Web Audio: engines disagree about which URL
        // schemes a worklet module may be fetched from, and a rejection
        // surfaces as an opaque error long after the decision that caused it.
        // Rather than pick the scheme that happens to work on the browser in
        // front of us, hand the renderer every option and let it try them in
        // order. Costs one string per scheme and removes a whole class of
        // browser-specific failure.
        //
        // The URLs are minted once, at module scope, and never revoked. A
        // revoked blob URL cannot be re-added, and `addModule` may run again
        // on a second AudioContext (an XR session restarting audio, a test
        // building a fresh one), which would then fail with a network error
        // rather than anything that names the cause.
        return [
          `const source = ${JSON.stringify(code)};`,
          `const urls = [];`,
          `try { urls.push(URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))); } catch (e) {}`,
          // btoa needs latin1, so UTF-8 is widened a byte at a time first.
          `try {`,
          `  const bytes = new TextEncoder().encode(source);`,
          `  let binary = '';`,
          `  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);`,
          `  urls.push('data:text/javascript;base64,' + btoa(binary));`,
          `} catch (e) {}`,
          `try { urls.push('data:text/javascript,' + encodeURIComponent(source)); } catch (e) {}`,
          `export default urls;`,
        ].join('\n');
      }
      if (this.meta.watchMode) {
        return `export default '/crate-voice-processor.worklet.js';`;
      }
      const { code } = await bundle();
      this.emitFile({
        type: 'asset',
        fileName: 'assets/crate-voice-processor.worklet.js',
        source: code,
      });
      return `export default '${assetPrefix}/assets/crate-voice-processor.worklet.js';`;
    },
  };
}
