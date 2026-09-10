/**
 * NSKeyedArchiver / binary-plist decoder for AU `fullState` blobs.
 * Real amp/grain/synth state is Apple's parameter-tree dictionary plus
 * homecrate keys (`namFilename`, `irFilename`, ...). That archive always
 * contains `NSData` (bplist marker `0x4f` when the blob is 15 bytes or
 * longer). Skipping data used to throw and drop the whole preset, which
 * left every imported amp on the analog path.
 */

type PlistValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue }
  | { uid: number };

function readUInt(view: DataView, offset: number, size: number): number {
  if (size === 1) return view.getUint8(offset);
  if (size === 2) return view.getUint16(offset);
  if (size === 4) return view.getUint32(offset);
  if (size === 8) {
    const hi = view.getUint32(offset);
    const lo = view.getUint32(offset + 4);
    return hi * 0x100000000 + lo;
  }
  throw new Error(`bplist: unsupported int size ${size}`);
}

function parseBplist(bytes: Uint8Array): PlistValue {
  if (bytes.length < 40) throw new Error('bplist: too short');
  const header = String.fromCharCode(...bytes.subarray(0, 8));
  if (!header.startsWith('bplist')) throw new Error('bplist: missing header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetSize = view.getUint8(trailer + 6);
  const refSize = view.getUint8(trailer + 7);
  const numObjects = readUInt(view, trailer + 8, 8);
  const rootIndex = readUInt(view, trailer + 16, 8);
  const tableOffset = readUInt(view, trailer + 24, 8);

  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) {
    offsets.push(readUInt(view, tableOffset + i * offsetSize, offsetSize));
  }

  const cache = new Array<PlistValue | undefined>(numObjects);

  function readRef(at: number): number {
    return readUInt(view, at, refSize);
  }

  function readCounted(offset: number, info: number): { length: number; dataOffset: number } {
    if (info !== 0x0f) return { length: info, dataOffset: offset + 1 };
    const lenMarker = view.getUint8(offset + 1);
    const lenSize = 1 << (lenMarker & 0x0f);
    return { length: readUInt(view, offset + 2, lenSize), dataOffset: offset + 2 + lenSize };
  }

  function parseObject(index: number): PlistValue {
    const cached = cache[index];
    if (cached !== undefined) return cached;
    const offset = offsets[index]!;
    const marker = view.getUint8(offset);
    const kind = marker >> 4;
    const info = marker & 0x0f;
    let value: PlistValue;

    if (kind === 0x0) {
      if (info === 0) value = null;
      else if (info === 8) value = false;
      else if (info === 9) value = true;
      else value = null;
    } else if (kind === 0x1) {
      const size = 1 << info;
      value = readUInt(view, offset + 1, size);
    } else if (kind === 0x2) {
      if (info === 2) value = view.getFloat32(offset + 1);
      else if (info === 3) value = view.getFloat64(offset + 1);
      else throw new Error(`bplist: bad real size ${info}`);
    } else if (kind === 0x3) {
      value = view.getFloat64(offset + 1);
    } else if (kind === 0x4) {
      const counted = readCounted(offset, info);
      value = bytes.slice(counted.dataOffset, counted.dataOffset + counted.length);
    } else if (kind === 0x5 || kind === 0x6 || kind === 0x7) {
      const counted = readCounted(offset, info);
      if (kind === 0x5) {
        value = String.fromCharCode(...bytes.subarray(counted.dataOffset, counted.dataOffset + counted.length));
      } else if (kind === 0x6) {
        value = new TextDecoder('utf-16be').decode(
          bytes.subarray(counted.dataOffset, counted.dataOffset + counted.length * 2),
        );
      } else {
        value = new TextDecoder().decode(bytes.subarray(counted.dataOffset, counted.dataOffset + counted.length));
      }
    } else if (kind === 0x8) {
      const size = info + 1;
      value = { uid: readUInt(view, offset + 1, size) };
    } else if (kind === 0xa || kind === 0xc || kind === 0xd) {
      const counted = readCounted(offset, info);
      if (kind === 0xd) {
        const keys: string[] = [];
        const vals: PlistValue[] = [];
        for (let i = 0; i < counted.length; i++) {
          keys.push(String(parseObject(readRef(counted.dataOffset + i * refSize))));
        }
        for (let i = 0; i < counted.length; i++) {
          vals.push(parseObject(readRef(counted.dataOffset + counted.length * refSize + i * refSize)));
        }
        const obj: Record<string, PlistValue> = {};
        for (let i = 0; i < counted.length; i++) obj[keys[i]!] = vals[i]!;
        value = obj;
      } else {
        const arr: PlistValue[] = [];
        for (let i = 0; i < counted.length; i++) {
          arr.push(parseObject(readRef(counted.dataOffset + i * refSize)));
        }
        value = arr;
      }
    } else {
      throw new Error(`bplist: unsupported marker 0x${marker.toString(16)}`);
    }

    cache[index] = value;
    return value;
  }

  return parseObject(rootIndex);
}

function resolveUid(value: PlistValue, objects: PlistValue[]): PlistValue {
  if (value && typeof value === 'object' && 'uid' in value && Object.keys(value).length === 1) {
    return resolveUid(objects[(value as { uid: number }).uid]!, objects);
  }
  return value;
}

function asPlain(value: PlistValue, objects: PlistValue[]): unknown {
  const resolved = resolveUid(value, objects);
  if (resolved === null || typeof resolved === 'string' || typeof resolved === 'number' || typeof resolved === 'boolean') {
    return resolved;
  }
  if (resolved instanceof Uint8Array) return resolved;
  if (Array.isArray(resolved)) {
    return resolved.map((item) => asPlain(item, objects));
  }
  if (resolved && typeof resolved === 'object') {
    const rec = resolved as Record<string, PlistValue>;
    if (rec['NS.string'] !== undefined) {
      return asPlain(rec['NS.string'], objects);
    }
    if (rec['NS.dblval'] !== undefined) return asPlain(rec['NS.dblval'], objects);
    if (rec['NS.intval'] !== undefined) return asPlain(rec['NS.intval'], objects);
    if (rec['NS.boolval'] !== undefined) return asPlain(rec['NS.boolval'], objects);
    if (rec['NS.number'] !== undefined) return asPlain(rec['NS.number'], objects);
    if (rec['NS.keys'] && rec['NS.objects']) {
      const keys = asPlain(rec['NS.keys'], objects) as unknown[];
      const vals = asPlain(rec['NS.objects'], objects) as unknown[];
      const out: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) out[String(keys[i])] = vals[i];
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(rec)) {
      if (key === '$class') continue;
      out[key] = asPlain(item, objects);
    }
    return out;
  }
  return resolved;
}

export function decodeKeyedArchive(bytes: Uint8Array): Record<string, unknown> {
  const root = parseBplist(bytes);
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('keyed archive: root is not a dictionary');
  }
  const dict = root as Record<string, PlistValue>;
  const objects = dict.$objects;
  if (!Array.isArray(objects)) {
    return asPlain(root, []) as Record<string, unknown>;
  }
  const top = dict.$top;
  if (top && typeof top === 'object' && !Array.isArray(top)) {
    const topDict = top as Record<string, PlistValue>;
    const rootRef = topDict.root ?? topDict.NSKeyedArchiveRootObjectKey;
    if (rootRef !== undefined) {
      const candidate =
        typeof rootRef === 'number' ? objects[rootRef] : rootRef;
      const decoded = asPlain(candidate ?? rootRef, objects);
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        return decoded as Record<string, unknown>;
      }
    }
  }
  if (objects[1] !== undefined) {
    const decoded = asPlain(objects[1], objects);
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
  }
  throw new Error('keyed archive: no root dictionary');
}

export function decodePresetBlob(base64: string): Record<string, unknown> {
  const trimmed = base64.trim();
  let bytes: Uint8Array;
  if (typeof Buffer !== 'undefined') {
    bytes = Uint8Array.from(Buffer.from(trimmed, 'base64'));
  } else {
    const binary = atob(trimmed);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  if (bytes.length >= 8) {
    const header = String.fromCharCode(...bytes.subarray(0, 8));
    if (header.startsWith('bplist')) return decodeKeyedArchive(bytes);
  }
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('preset blob: JSON root is not an object');
  }
  return parsed as Record<string, unknown>;
}
