/**
 * The wire format for live peer state.
 *
 * A track's gain and pan and a Material's automated parameters are the same
 * shape: lots of small numeric state, changing at different rates, most of
 * it unchanged on any given tick.
 *
 * Four ideas, and each one is paying for something:
 *
 * 1. **A four-byte header.** Protocol version, message type, and a 16-bit
 *    hash of the sender's id, so a packet sent sixty times a second never
 *    carries a 36-character UUID. The hash collides at about 1 in 65536,
 *    which for a room of peers is a non-event, and a receiver resolves it
 *    against the peers it actually knows.
 * 2. **A presence mask.** One bit per field, then only the fields whose bit
 *    is set. A peer moving one fader sends one number, not the whole state.
 * 3. **Quantization.** A gain is not worth 32 bits. `q16` over a declared
 *    range is inaudible at the resolutions used here and halves the payload.
 * 4. **Append-only growth.** Fields serialize in ascending bit order, so a
 *    decoder that knows fewer of them reads the prefix it understands and
 *    ignores the trailing bytes. An old sender never sets a bit a new
 *    decoder would read, and a new sender's extra fields fall off the end of
 *    an old one. Neither side has to know the other's version.
 *
 * What this is deliberately not: a general serialization format. Crate
 * supplies the mechanism and an application declares its own fields, the
 * same way it declares its own Materials.
 */

export const CRATE_PROTOCOL_VERSION = 1;

/**
 * Message types. Values are wire constants: change one and old peers
 * misread new packets, so append rather than renumber.
 */
export const MESSAGE = {
  /** Continuous per-peer state: faders, transport position, parameters. */
  peerState: 1,
  /** Clock synchronisation round trip. See `SessionClock`. */
  heartbeat: 2,
  /** A discrete, ordered change: play, stop, a clip edit. */
  edit: 3,
  /** Binary payload. SceneSync ignores it; a host may listen on the transport. */
  blob: 4,
} as const;

export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];

/** How one field crosses the wire. */
export type FieldEncoding =
  | { kind: 'f32' }
  /** Unsigned 16-bit over a declared range. Resolution is `(max - min) / 65535`. */
  | { kind: 'q16'; min: number; max: number }
  /** A flag, or a small count. */
  | { kind: 'u8' };

export interface StateField {
  name: string;
  /**
   * How a receiver blends this field across the jitter buffer. `lerp` for
   * anything continuous, `step` for anything that is not: a play flag
   * interpolated halfway through its flip reads 0.5, which is neither
   * playing nor stopped, and a track index blended between 2 and 3 is
   * track 2.5.
   */
  interpolate?: 'lerp' | 'step';
  /**
   * Which presence-mask bit this field owns. Assign once and never reuse:
   * a recycled bit is an old peer confidently decoding the wrong field.
   */
  bit: number;
  encoding: FieldEncoding;
}

/** Bytes a field occupies when present. */
function fieldWidth(encoding: FieldEncoding): number {
  switch (encoding.kind) {
    case 'f32':
      return 4;
    case 'q16':
      return 2;
    case 'u8':
      return 1;
  }
}

/**
 * FNV-1a folded to 16 bits. A stable, dependency-free hash of a peer id, so
 * the wire carries two bytes instead of a UUID.
 */
export function peerHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash >>> 16) ^ (hash & 0xffff)) & 0xffff;
}

export interface DecodedState {
  version: number;
  type: MessageType;
  peerHash: number;
  /** Only the fields whose presence bit was set. */
  fields: Record<string, number>;
}

const HEADER_BYTES = 4;

export class StateCodec {
  private readonly fields: readonly StateField[];
  private readonly maskBytes: number;

  constructor(fields: readonly StateField[]) {
    const bits = new Set<number>();
    for (const field of fields) {
      if (!Number.isInteger(field.bit) || field.bit < 0) {
        throw new RangeError(`collab field "${field.name}": bit must be a non-negative integer`);
      }
      if (bits.has(field.bit)) {
        throw new RangeError(`collab field "${field.name}": bit ${field.bit} is already taken`);
      }
      bits.add(field.bit);
    }
    // Ascending bit order is the append-only property: a decoder that knows
    // fewer fields reads a prefix, never a misaligned middle.
    this.fields = [...fields].sort((a, b) => a.bit - b.bit);
    const highest = this.fields.length === 0 ? 0 : this.fields[this.fields.length - 1]!.bit;
    this.maskBytes = Math.max(1, Math.ceil((highest + 1) / 8));
  }

  /** Bytes of mask this codec writes. Both peers must agree, so it comes from the shared field table. */
  get maskByteLength(): number {
    return this.maskBytes;
  }

  /** Fields that must not be interpolated. See `StateField.interpolate`. */
  get stepFields(): readonly string[] {
    return this.fields.filter((field) => field.interpolate === 'step').map((field) => field.name);
  }

  /**
   * Encodes whichever fields are present in `state`. A field left out, or
   * set to undefined, simply does not travel: that is the point of the mask.
   */
  encode(id: string, state: Readonly<Record<string, number | undefined>>, type: MessageType = MESSAGE.peerState): Uint8Array {
    const present = this.fields.filter((field) => state[field.name] !== undefined);
    let size = HEADER_BYTES + this.maskBytes;
    for (const field of present) size += fieldWidth(field.encoding);

    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    bytes[0] = CRATE_PROTOCOL_VERSION;
    bytes[1] = type;
    view.setUint16(2, peerHash(id), true);

    for (const field of present) {
      bytes[HEADER_BYTES + (field.bit >> 3)]! |= 1 << (field.bit & 7);
    }

    let offset = HEADER_BYTES + this.maskBytes;
    for (const field of present) {
      const value = state[field.name]!;
      switch (field.encoding.kind) {
        case 'f32':
          view.setFloat32(offset, value, true);
          offset += 4;
          break;
        case 'q16':
          view.setUint16(offset, quantize16(value, field.encoding.min, field.encoding.max), true);
          offset += 2;
          break;
        case 'u8':
          bytes[offset] = Math.max(0, Math.min(255, Math.round(value)));
          offset += 1;
          break;
      }
    }
    return bytes;
  }

  /**
   * Decodes what this build understands. Returns null for a packet from a
   * future major version or one too short to be one at all, rather than
   * throwing: a malformed packet on a peer-to-peer link is a fact of life
   * and must not take the session down.
   */
  decode(bytes: Uint8Array): DecodedState | null {
    if (bytes.length < HEADER_BYTES + this.maskBytes) return null;
    const version = bytes[0]!;
    if (version !== CRATE_PROTOCOL_VERSION) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoded: DecodedState = {
      version,
      type: bytes[1]! as MessageType,
      peerHash: view.getUint16(2, true),
      fields: {},
    };

    let offset = HEADER_BYTES + this.maskBytes;
    for (const field of this.fields) {
      const maskByte = bytes[HEADER_BYTES + (field.bit >> 3)] ?? 0;
      if ((maskByte & (1 << (field.bit & 7))) === 0) continue;
      const width = fieldWidth(field.encoding);
      // The append-only guarantee: a sender that knows more fields than this
      // decoder appends them after the ones it shares, so running out of
      // bytes means "the rest is not mine to read", not "corrupt".
      if (offset + width > bytes.length) break;
      switch (field.encoding.kind) {
        case 'f32':
          decoded.fields[field.name] = view.getFloat32(offset, true);
          break;
        case 'q16':
          decoded.fields[field.name] = dequantize16(view.getUint16(offset, true), field.encoding.min, field.encoding.max);
          break;
        case 'u8':
          decoded.fields[field.name] = bytes[offset]!;
          break;
      }
      offset += width;
    }
    return decoded;
  }
}

/** Maps `[min, max]` onto a uint16, clamping out-of-range input rather than wrapping it. */
export function quantize16(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round(((clamped - min) / (max - min)) * 65535);
}

export function dequantize16(raw: number, min: number, max: number): number {
  return min + (raw / 65535) * (max - min);
}

/**
 * The fields crate itself knows how to sync. An application adds its own by
 * building its own codec; these are here because every session has them and
 * two peers should not have to agree on a bit number for "gain".
 */
export const CRATE_PEER_FIELDS: readonly StateField[] = [
  { name: 'gain', bit: 0, encoding: { kind: 'q16', min: 0, max: 2 } },
  { name: 'pan', bit: 1, encoding: { kind: 'q16', min: -1, max: 1 } },
  /** Transport playhead in seconds. Full precision: this one is time. */
  { name: 'position', bit: 2, encoding: { kind: 'f32' } },
  { name: 'playing', bit: 3, encoding: { kind: 'u8' }, interpolate: 'step' },
  { name: 'bpm', bit: 4, encoding: { kind: 'q16', min: 20, max: 300 } },
  /** Which track this packet is about, for a session syncing more than one. */
  { name: 'track', bit: 5, encoding: { kind: 'u8' }, interpolate: 'step' },
];

export const cratePeerCodec = new StateCodec(CRATE_PEER_FIELDS);
