export interface VoiceSnapshot {
  index: number;
  note: number | null;
  velocity: number;
  startedAt: number;
  held: boolean;
}

export type VoiceStealingPolicy = 'oldest' | 'quietest' | ((a: VoiceSnapshot, b: VoiceSnapshot) => number);

/**
 * Pick a slot for `note`. Same-pitch retrigger first, then idle, then the
 * oldest releasing tail, then steal a held voice per policy.
 */
export function allocateSlot(slots: readonly VoiceSnapshot[], note: number, policy: VoiceStealingPolicy): number {
  if (slots.length === 0) {
    throw new RangeError('allocateSlot: polyphony is 0');
  }
  const retrigger = slots.find((slot) => slot.held && slot.note === note);
  if (retrigger) return retrigger.index;

  const idle = slots.find((slot) => slot.note === null);
  if (idle) return idle.index;

  const releasing = slots.filter((slot) => slot.note !== null && !slot.held);
  if (releasing.length > 0) return oldest(releasing).index;

  return steal(slots.filter((slot) => slot.held), policy).index;
}

function oldest(slots: readonly VoiceSnapshot[]): VoiceSnapshot {
  return slots.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
}

function steal(held: readonly VoiceSnapshot[], policy: VoiceStealingPolicy): VoiceSnapshot {
  if (held.length === 0) {
    throw new RangeError('allocateSlot: no stealable voice');
  }
  if (typeof policy === 'function') {
    return [...held].sort(policy)[0]!;
  }
  if (policy === 'quietest') {
    return held.reduce((a, b) => {
      if (a.velocity !== b.velocity) return a.velocity < b.velocity ? a : b;
      return a.startedAt <= b.startedAt ? a : b;
    });
  }
  return oldest(held);
}
