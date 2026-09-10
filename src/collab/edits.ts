import { CRATE_PROTOCOL_VERSION, MESSAGE, peerHash } from './protocol';

export type EditValue = Record<string, number | string | boolean | null>;

/**
 * A discrete change: play, stop, a clip trim, a mute. Continuous faders
 * stay on `peerState`. These are rare, ordered, and last-write-wins.
 *
 * Policy: for one `target`, the edit with the highest `(wall time, peerId, seq)`
 * is kept. The discarded write is not applied. `onConflict` fires so a host
 * can show that two people edited the same thing; it does not retry.
 */
export interface SceneEdit {
  seq: number;
  time: number;
  peerId: string;
  /** Identity of the thing being changed. Concurrent writes to the same target race. */
  target: string;
  kind: string;
  value: EditValue;
}

export interface EditConflict {
  target: string;
  kept: SceneEdit;
  discarded: SceneEdit;
}

const HEADER = 4;
const SEQ_AND_TIME = 4 + 8;

export function encodeEdit(edit: SceneEdit): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({
      target: edit.target,
      kind: edit.kind,
      value: edit.value,
      peerId: edit.peerId,
    }),
  );
  const bytes = new Uint8Array(HEADER + SEQ_AND_TIME + json.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = CRATE_PROTOCOL_VERSION;
  bytes[1] = MESSAGE.edit;
  view.setUint16(2, peerHash(edit.peerId), true);
  view.setUint32(4, edit.seq >>> 0, true);
  view.setFloat64(8, edit.time, true);
  bytes.set(json, HEADER + SEQ_AND_TIME);
  return bytes;
}

export function decodeEdit(bytes: Uint8Array, fromPeerId: string): SceneEdit | null {
  if (bytes.length < HEADER + SEQ_AND_TIME) return null;
  if (bytes[0] !== CRATE_PROTOCOL_VERSION || bytes[1] !== MESSAGE.edit) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let body: { target?: unknown; kind?: unknown; value?: unknown; peerId?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER + SEQ_AND_TIME))) as {
      target?: unknown;
      kind?: unknown;
      value?: unknown;
      peerId?: unknown;
    };
  } catch {
    return null;
  }
  if (typeof body.target !== 'string' || typeof body.kind !== 'string') return null;
  if (body.value == null || typeof body.value !== 'object' || Array.isArray(body.value)) return null;
  // Author lives in the body so a peer can relay accepted edits to a late
  // joiner without becoming the author. `from` is the fallback when an older
  // packet omitted it.
  const author = typeof body.peerId === 'string' && body.peerId.length > 0 ? body.peerId : fromPeerId;
  return {
    seq: view.getUint32(4, true),
    time: view.getFloat64(8, true),
    peerId: author,
    target: body.target,
    kind: body.kind,
    value: body.value as EditValue,
  };
}

/** Positive if `a` outranks `b`: later time, then greater peer id, then seq. */
export function compareEdits(a: SceneEdit, b: SceneEdit): number {
  if (a.time !== b.time) return a.time - b.time;
  if (a.peerId !== b.peerId) return a.peerId < b.peerId ? -1 : 1;
  return a.seq - b.seq;
}
