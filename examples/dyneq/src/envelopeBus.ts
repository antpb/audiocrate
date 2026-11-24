/**
 * hc_send's broadcast, as the AU does it (EnvelopeBus.h): every hc_send in
 * the session publishes its block peak x SEND, and every hc_dynEQ reads the
 * loudest live one. A sender silent for more than 150 ms counts as gone, so
 * a duck it drove lets go.
 *
 * The AU's bus is a process global, shared because every instance lives in
 * one extension process. The web's equivalent is the worklet realm: every
 * voice in an AudioContext runs in one AudioWorkletGlobalScope, so a global
 * there is shared by every hc_send and hc_dynEQ in the scene, and by nothing
 * outside it. Time is the realm's `currentTime`.
 */
const STALE_SECONDS = 0.15;
const KEY = Symbol.for('homecrate.envelopeBus');

interface Slot {
  level: number;
  at: number;
}

function slots(): Map<number, Slot> {
  const scope = globalThis as unknown as Record<symbol, Map<number, Slot> | undefined>;
  let map = scope[KEY];
  if (!map) {
    map = new Map();
    scope[KEY] = map;
  }
  return map;
}

function now(): number {
  return Number((globalThis as unknown as { currentTime?: number }).currentTime ?? 0);
}

let nextId = 1;

export function claimSendSlot(): number {
  const id = nextId++;
  slots().set(id, { level: 0, at: -Infinity });
  return id;
}

export function releaseSendSlot(id: number): void {
  slots().delete(id);
}

export function publishSend(id: number, level: number): void {
  const slot = slots().get(id);
  if (!slot) return;
  slot.level = level;
  slot.at = now();
}

/** The loudest sender heard within the last 150 ms, or 0. */
export function readSendMax(): number {
  const t = now();
  let max = 0;
  for (const slot of slots().values()) {
    if (t - slot.at > STALE_SECONDS) continue;
    if (slot.level > max) max = slot.level;
  }
  return max;
}
