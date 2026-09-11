import type { AudioMaterial } from '../graph/AudioMaterial';
import { allocateSlot, type VoiceSnapshot, type VoiceStealingPolicy } from './allocate';

export interface VoiceBackend {
  noteOn(params: Record<string, number>): void;
  noteOff(): void;
  setParam(name: string, value: number): void;
}

interface Slot extends VoiceSnapshot {
  voice: VoiceBackend;
}

/**
 * One pool per AudioMaterial. Release tails keep occupying a
 * slot until stolen or allNotesOff; steal cuts the tail with noteOff then
 * noteOn on the same backend.
 */
export class VoicePool {
  private readonly slots: Slot[];
  private clock = 0;
  private readonly policy: VoiceStealingPolicy;

  constructor(
    private readonly material: AudioMaterial,
    voices: VoiceBackend[],
    policy: VoiceStealingPolicy = 'oldest',
  ) {
    if (voices.length === 0) throw new RangeError('VoicePool: need at least one voice');
    this.policy = policy;
    this.slots = voices.map((voice, index) => ({
      index,
      voice,
      note: null,
      velocity: 0,
      startedAt: 0,
      held: false,
    }));
  }

  noteOn(note: number, options: { velocity?: number } & Record<string, number> = {}): void {
    const velocity = options.velocity ?? 1;
    const index = allocateSlot(this.slots, note, this.policy);
    const slot = this.slots[index]!;
    if (slot.note !== null) slot.voice.noteOff();
    slot.note = note;
    slot.velocity = velocity;
    slot.held = true;
    slot.startedAt = ++this.clock;
    slot.voice.noteOn({
      ...this.material.snapshotParams(),
      ...options,
      note,
      velocity,
    });
  }

  noteOff(note: number): void {
    for (const slot of this.slots) {
      if (!slot.held || slot.note !== note) continue;
      slot.held = false;
      slot.voice.noteOff();
      return;
    }
  }

  allNotesOff(): void {
    for (const slot of this.slots) {
      if (slot.note === null) continue;
      slot.held = false;
      slot.note = null;
      slot.velocity = 0;
      slot.voice.noteOff();
    }
  }

  setParam(name: string, value: number): void {
    for (const slot of this.slots) slot.voice.setParam(name, value);
  }

  snapshots(): VoiceSnapshot[] {
    return this.slots.map(({ index, note, velocity, startedAt, held }) => ({
      index,
      note,
      velocity,
      startedAt,
      held,
    }));
  }
}
