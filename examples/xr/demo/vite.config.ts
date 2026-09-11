import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type ViteDevServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xrRoot = path.resolve(__dirname, '..');
const crateRoot = path.resolve(xrRoot, '../..');
const pluginFile = path.join(xrRoot, 'dist/crate-stones-xr-publisher-plugin.umd.js');
const demoAssets = path.join(__dirname, 'assets');

function findPublisher(): string {
  const candidates = [
    path.join(xrRoot, 'node_modules/@antpb/xr-publisher'),
    path.join(crateRoot, 'node_modules/@antpb/xr-publisher'),
    path.join(crateRoot, '../../node_modules/@antpb/xr-publisher'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'dist/xr-publisher.umd.js'))) return dir;
  }
  throw new Error(
    '@antpb/xr-publisher is not installed. From the audiocrate package root: npm install',
  );
}

const publisher = findPublisher();
const publisherDist = path.join(publisher, 'dist');

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrm': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function sendFile(res: ServerResponse, file: string): void {
  res.setHeader('Content-Type', mimeFor(file));
  createReadStream(file).pipe(res);
}

function serveRuntime(server: ViteDevServer): void {
  server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');

    if (url === '/xr-publisher.umd.js' || url === '/xr-publisher.umd.js.map') {
      const file = path.join(publisherDist, path.basename(url));
      if (!existsSync(file)) return next();
      sendFile(res, file);
      return;
    }

    if (url === '/crate-stones-xr-publisher-plugin.umd.js') {
      if (!existsSync(pluginFile)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Plugin not built. From the audiocrate package root: npm run example:xr');
        return;
      }
      sendFile(res, pluginFile);
      return;
    }

    if (url.startsWith('/assets/defaults/')) {
      const file = path.normalize(path.join(publisherDist, url));
      const root = path.normalize(publisherDist) + path.sep;
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
        return next();
      }
      sendFile(res, file);
      return;
    }

    if (url.startsWith('/assets/')) {
      const file = path.normalize(path.join(demoAssets, url.slice('/assets/'.length)));
      const root = path.normalize(demoAssets) + path.sep;
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
        return next();
      }
      sendFile(res, file);
      return;
    }

    next();
  });
}

export default defineConfig({
  root: __dirname,
  publicDir: false,
  server: {
    port: 5176,
    strictPort: true,
    open: true,
    fs: { allow: [crateRoot, publisher] },
  },
  plugins: [
    {
      name: 'serve-xr-publisher-runtime',
      configureServer: serveRuntime,
    },
  ],
});
