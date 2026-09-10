import { unzipSync } from 'fflate';

export type ZipEntry = {
  name: string;
};

export function normalizeZipName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

const unzipped = new WeakMap<Uint8Array, Record<string, Uint8Array>>();

function unzipAll(data: Uint8Array): Record<string, Uint8Array> {
  const hit = unzipped.get(data);
  if (hit) return hit;
  const files = unzipSync(data);
  unzipped.set(data, files);
  return files;
}

export function listZipEntries(data: Uint8Array): ZipEntry[] {
  return Object.keys(unzipAll(data)).map((name) => ({ name }));
}

export async function readZipEntry(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const bytes = unzipAll(data)[entry.name];
  if (!bytes) throw new Error(`zip: missing ${entry.name}`);
  return bytes;
}
