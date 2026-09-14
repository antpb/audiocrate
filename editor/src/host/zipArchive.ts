import { inflate as fflateInflate, inflateSync } from 'fflate';

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const ZIP64_SENTINEL = 0xffffffff;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const ASYNC_INFLATE_BYTES = 256 * 1024;

export type ZipEntry = {
  name: string;
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
};

export function normalizeZipName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function listZipEntries(data: Uint8Array): ZipEntry[] {
  return listEntries(data);
}

export async function readZipEntry(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const start = payloadStart(data, entry.localOffset);
  const end = start + entry.compressed;
  if (end > data.length) {
    throw new Error(`zip: truncated payload for ${entry.name}`);
  }
  const payload = data.subarray(start, end);
  if (entry.method === METHOD_STORE) {
    return detach(payload);
  }
  if (entry.method === METHOD_DEFLATE) {
    if (entry.uncompressed > MAX_ENTRY_BYTES && entry.uncompressed !== ZIP64_SENTINEL) {
      throw new Error(`zip: implausible uncompressed size for ${entry.name}`);
    }
    return inflateEntry(payload, entry.uncompressed === ZIP64_SENTINEL ? 0 : entry.uncompressed);
  }
  throw new Error(`zip: unsupported method ${entry.method} for ${entry.name}`);
}

function u16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function u32(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function u64(data: Uint8Array, offset: number): number {
  const lo = u32(data, offset);
  const hi = u32(data, offset + 4);
  if (hi > 0x1fffff) {
    throw new Error('zip: 64-bit size exceeds JS safe integer');
  }
  return hi * 0x100000000 + lo;
}

function decodeName(data: Uint8Array, offset: number, length: number, utf8: boolean): string {
  const bytes = data.subarray(offset, offset + length);
  return new TextDecoder(utf8 ? 'utf-8' : 'latin1').decode(bytes);
}

function readZip64Sizes(
  extra: Uint8Array,
  compressed: number,
  uncompressed: number,
  localOffset: number,
): { compressed: number; uncompressed: number; localOffset: number } {
  const needCompressed = compressed === ZIP64_SENTINEL;
  const needUncompressed = uncompressed === ZIP64_SENTINEL;
  const needOffset = localOffset === ZIP64_SENTINEL;
  if (!needCompressed && !needUncompressed && !needOffset) {
    return { compressed, uncompressed, localOffset };
  }
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = u16(extra, cursor);
    const size = u16(extra, cursor + 2);
    const start = cursor + 4;
    const end = start + size;
    if (end > extra.length) break;
    if (id === 1) {
      let field = start;
      const nextUncompressed = needUncompressed && field + 8 <= end ? u64(extra, field) : uncompressed;
      if (needUncompressed) field += 8;
      const nextCompressed = needCompressed && field + 8 <= end ? u64(extra, field) : compressed;
      if (needCompressed) field += 8;
      const nextOffset = needOffset && field + 8 <= end ? u64(extra, field) : localOffset;
      return {
        compressed: nextCompressed,
        uncompressed: nextUncompressed,
        localOffset: nextOffset,
      };
    }
    cursor = end;
  }
  return { compressed, uncompressed, localOffset };
}

function findEocd(data: Uint8Array): number {
  const min = Math.max(0, data.length - 22 - 65535);
  for (let i = data.length - 22; i >= min; i--) {
    if (u32(data, i) === SIG_EOCD) return i;
  }
  throw new Error('zip: missing end-of-central-directory');
}

function listEntries(data: Uint8Array): ZipEntry[] {
  const eocd = findEocd(data);
  let count = u16(data, eocd + 8);
  let cdOffset = u32(data, eocd + 16);
  if (eocd >= 20 && u32(data, eocd - 20) === SIG_ZIP64_LOCATOR) {
    const zip64Eocd = u64(data, eocd - 12);
    if (zip64Eocd + 56 <= data.length && u32(data, zip64Eocd) === SIG_ZIP64_EOCD) {
      count = u64(data, zip64Eocd + 32);
      cdOffset = u64(data, zip64Eocd + 48);
    }
  }
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > data.length || u32(data, cursor) !== SIG_CD) {
      throw new Error('zip: corrupt central directory');
    }
    const method = u16(data, cursor + 10);
    const flags = u16(data, cursor + 8);
    let compressed = u32(data, cursor + 20);
    let uncompressed = u32(data, cursor + 24);
    const nameLen = u16(data, cursor + 28);
    const extraLen = u16(data, cursor + 30);
    const commentLen = u16(data, cursor + 32);
    let localOffset = u32(data, cursor + 42);
    const name = decodeName(data, cursor + 46, nameLen, (flags & 0x800) !== 0);
    const extra = data.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
    const sized = readZip64Sizes(extra, compressed, uncompressed, localOffset);
    compressed = sized.compressed;
    uncompressed = sized.uncompressed;
    localOffset = sized.localOffset;
    entries.push({ name, method, compressed, uncompressed, localOffset });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function payloadStart(data: Uint8Array, localOffset: number): number {
  if (localOffset + 30 > data.length || u32(data, localOffset) !== SIG_LOCAL) {
    throw new Error('zip: missing local file header');
  }
  return localOffset + 30 + u16(data, localOffset + 26) + u16(data, localOffset + 28);
}

function inflateAsync(payload: Uint8Array, size?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const opts = size && size < MAX_ENTRY_BYTES ? { size } : {};
    fflateInflate(payload, opts, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
}

async function inflateEntry(payload: Uint8Array, uncompressed: number): Promise<Uint8Array> {
  const known =
    uncompressed > 0 && uncompressed < MAX_ENTRY_BYTES && uncompressed !== ZIP64_SENTINEL
      ? uncompressed
      : undefined;
  if (known && known >= ASYNC_INFLATE_BYTES) {
    try {
      return await inflateAsync(payload, known);
    } catch {
      return inflateAsync(payload);
    }
  }
  try {
    return known ? inflateSync(payload, { out: new Uint8Array(known) }) : inflateSync(payload);
  } catch {
    return inflateSync(payload);
  }
}

function detach(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}
