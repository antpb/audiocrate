import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { listZipEntries, readZipEntry } from '../src/host/zipArchive';

function u16(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
}

function u32(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000);
  out.set(u32(lo), 0);
  out.set(u32(hi), 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildZip(
  files: Array<{ name: string; data: Uint8Array; deflate?: boolean }>,
  opts?: { zip64UncompressedLie?: boolean },
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const payload = file.deflate ? new Uint8Array(deflateRawSync(file.data)) : file.data;
    const crc = crc32(file.data) >>> 0;
    const local = concat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(file.deflate ? 8 : 0),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      payload,
    );
    const lie = opts?.zip64UncompressedLie === true;
    const extra = lie ? concat(u16(1), u16(8), u64(file.data.length)) : new Uint8Array();
    const central = concat(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(file.deflate ? 8 : 0),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(lie ? 0xffffffff : file.data.length),
      u16(name.length),
      u16(extra.length),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
      extra,
    );
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = concat(...centrals);
  const eocd = concat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  );
  return concat(...locals, cd, eocd);
}

describe('editor zipArchive', () => {
  it('lists the central directory without inflating payloads', async () => {
    const body = new TextEncoder().encode('hello from a stored entry');
    const archive = buildZip([
      { name: 'manifest.json', data: new TextEncoder().encode('{"kind":"homecrate-project-archive"}') },
      { name: 'audio/take.wav', data: body, deflate: true },
    ]);
    const entries = listZipEntries(archive);
    expect(entries.map((entry) => entry.name)).toEqual(['manifest.json', 'audio/take.wav']);
    const wav = entries.find((entry) => entry.name === 'audio/take.wav')!;
    expect(wav.uncompressed).toBe(body.length);
    expect(wav.compressed).toBeLessThan(body.length + 32);
    expect(await readZipEntry(archive, wav)).toEqual(body);
  });

  it('reads ZIP64 extras when the 32-bit uncompressed size is 0xffffffff', async () => {
    const body = new TextEncoder().encode('hello from a zip64 extra field');
    const archive = buildZip([{ name: 'audio/clip.wav', data: body, deflate: true }], {
      zip64UncompressedLie: true,
    });
    const [entry] = listZipEntries(archive);
    expect(entry.uncompressed).toBe(body.length);
    expect(await readZipEntry(archive, entry)).toEqual(body);
  });

  it('copies stored entries without keeping a view into the archive buffer', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const archive = buildZip([{ name: 'raw.bin', data: body }]);
    const [entry] = listZipEntries(archive);
    const out = await readZipEntry(archive, entry);
    expect(out).toEqual(body);
    archive.fill(0);
    expect(out).toEqual(body);
  });
});
