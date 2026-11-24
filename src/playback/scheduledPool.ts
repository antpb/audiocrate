/**
 * A pure ASL instrument playing a MIDI clip in a scene, sample-accurately.
 *
 * A kernel instrument (homecrate's synth) is one worklet voice that takes
 * timed MIDI and does its own polyphony. A pure ASL instrument (a crate
 * patch, the drum) has neither: its graph is one note, so polyphony is
 * `material.polyphony` worklet voices and something has to choose which
 * voice plays which note. `VoicePool` does that on the main thread at the
 * moment a note starts, which in a scene means a `setTimeout` per note: a few
 * milliseconds late at best, and a second late in a background tab.
 *
 * This target does the choosing ahead of time instead. `MidiPlayback` hands a
 * scheduled target every note of a play at once, each with its AudioContext
 * time, so the target collects them, sorts them by time, assigns voices on
 * that timeline with `VoicePool`'s policy (a free voice first, else steal the
 * oldest, gating it off just before), and posts each voice its own timed
 * `noteOn` / `noteOff`. The worklet applies them at the exact sample.
 */
import type { AudioMaterial } from '../graph/AudioMaterial';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';
import type { MidiVoiceTarget } from './MidiPlayback';

type PoolEvent =
  | { kind: 'on'; note: number; velocity: number; when: number; order: number }
  | { kind: 'off'; note: number; when: number; order: number };

interface Slot {
  note: number | null;
  held: boolean;
  startedAt: number;
  releasedAt: number;
}

export interface ScheduledPoolTarget extends MidiVoiceTarget {
  readonly scheduled: true;
}

/**
 * `voices` are the pool (one per note of polyphony), already created and
 * connected by the caller. `now()` is the AudioContext clock, for notes sent
 * without a time.
 */
export function scheduledPoolTarget(
  material: AudioMaterial,
  voices: readonly VoiceHandle[],
  now: () => number,
): ScheduledPoolTarget {
  const slots: Slot[] = voices.map(() => ({ note: null, held: false, startedAt: -Infinity, releasedAt: -Infinity }));
  let pending: PoolEvent[] = [];
  let order = 0;
  let flushQueued = false;

  const allocate = (event: Extract<PoolEvent, { kind: 'on' }>): void => {
    let index = -1;
    // A free voice, the one released longest ago (its tail has had the most time).
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (slot.held) continue;
      if (index === -1 || slot.releasedAt < slots[index]!.releasedAt) index = i;
    }
    // None free: steal the oldest note.
    if (index === -1) {
      for (let i = 0; i < slots.length; i++) {
        if (index === -1 || slots[i]!.startedAt < slots[index]!.startedAt) index = i;
      }
    }
    const slot = slots[index]!;
    const voice = voices[index]!;
    // Gate off before gating on, as VoicePool does, so a reused voice gets an edge.
    if (slot.held) voice.noteOff(event.when);
    slot.note = event.note;
    slot.held = true;
    slot.startedAt = event.when;
    voice.noteOn({ ...material.snapshotParams(), note: event.note, velocity: event.velocity }, event.when);
  };

  /** False when no held voice has that note (yet). */
  const release = (event: Extract<PoolEvent, { kind: 'off' }>): boolean => {
    let index = -1;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (!slot.held || slot.note !== event.note) continue;
      if (index === -1 || slot.startedAt < slots[index]!.startedAt) index = i;
    }
    if (index === -1) return false;
    const slot = slots[index]!;
    slot.held = false;
    slot.releasedAt = event.when;
    voices[index]!.noteOff(event.when);
    return true;
  };

  const flush = (): void => {
    flushQueued = false;
    const events = pending;
    pending = [];
    events.sort((a, b) => a.when - b.when || a.order - b.order);
    // One instant at a time: offs first, so a note repeated where the last
    // one ends gets its voice back; then ons; then any off that found no
    // note yet, which is a note that starts and ends at this instant.
    for (let i = 0; i < events.length; ) {
      let j = i;
      while (j < events.length && events[j]!.when === events[i]!.when) j++;
      const group = events.slice(i, j);
      const unmatched = group.filter((e): e is Extract<PoolEvent, { kind: 'off' }> => e.kind === 'off' && !release(e));
      for (const e of group) if (e.kind === 'on') allocate(e);
      for (const e of unmatched) release(e);
      i = j;
    }
  };

  const queue = (event: PoolEvent): void => {
    pending.push(event);
    if (flushQueued) return;
    flushQueued = true;
    // Every note of one play arrives in one synchronous call, so a microtask
    // sees them all before any voice is chosen.
    queueMicrotask(flush);
  };

  return {
    scheduled: true,
    noteOn(note, options) {
      queue({ kind: 'on', note, velocity: options?.velocity ?? 1, when: options?.when ?? now(), order: order++ });
    },
    noteOff(note, options) {
      queue({ kind: 'off', note, when: options?.when ?? now(), order: order++ });
    },
    allNotesOff() {
      pending = [];
      for (let i = 0; i < voices.length; i++) {
        const voice = voices[i]!;
        // Clears what the worklet has queued, then closes the gate now.
        voice.allNotesOff();
        voice.noteOff();
        const slot = slots[i]!;
        slot.held = false;
        slot.note = null;
        slot.releasedAt = now();
      }
    },
  };
}
