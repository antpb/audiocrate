import { describe, expect, it } from 'vitest';
import { uniform } from '../../src/asl/builders';
import { AudioMaterialNotBoundError } from '../../src/errors';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { allocateSlot, type VoiceSnapshot } from '../../src/voices/allocate';

function slot(partial: Partial<VoiceSnapshot> & Pick<VoiceSnapshot, 'index'>): VoiceSnapshot {
  return {
    note: null,
    velocity: 0,
    startedAt: 0,
    held: false,
    ...partial,
  };
}

describe('allocateSlot', () => {
  it('reuses a held slot for the same pitch', () => {
    const slots = [
      slot({ index: 0, note: 60, held: true, startedAt: 1 }),
      slot({ index: 1 }),
    ];
    expect(allocateSlot(slots, 60, 'oldest')).toBe(0);
  });

  it('prefers idle over stealing', () => {
    const slots = [slot({ index: 0, note: 60, held: true, startedAt: 1 }), slot({ index: 1 })];
    expect(allocateSlot(slots, 64, 'oldest')).toBe(1);
  });

  it('takes the oldest releasing tail before a held voice', () => {
    const slots = [
      slot({ index: 0, note: 60, held: true, startedAt: 1, velocity: 0.1 }),
      slot({ index: 1, note: 62, held: false, startedAt: 2 }),
      slot({ index: 2, note: 64, held: false, startedAt: 3 }),
    ];
    expect(allocateSlot(slots, 67, 'quietest')).toBe(1);
  });

  it('steals the oldest held voice', () => {
    const slots = [
      slot({ index: 0, note: 60, held: true, startedAt: 5, velocity: 0.2 }),
      slot({ index: 1, note: 64, held: true, startedAt: 2, velocity: 0.9 }),
    ];
    expect(allocateSlot(slots, 67, 'oldest')).toBe(1);
  });

  it('steals the quietest held voice', () => {
    const slots = [
      slot({ index: 0, note: 60, held: true, startedAt: 1, velocity: 0.9 }),
      slot({ index: 1, note: 64, held: true, startedAt: 2, velocity: 0.2 }),
    ];
    expect(allocateSlot(slots, 67, 'quietest')).toBe(1);
  });
});

function fakeVoice() {
  const events: string[] = [];
  return {
    events,
    noteOn(params: Record<string, number>) {
      events.push(`on:${params.note}:${params.velocity}`);
    },
    noteOff() {
      events.push('off');
    },
    setParam(name: string, value: number) {
      events.push(`p:${name}=${value}`);
    },
  };
}

describe('AudioMaterial.noteOn', () => {
  it('throws AudioMaterialNotBoundError before attachVoices', () => {
    const material = new AudioMaterial({ name: 'Pluck', polyphony: 2, graph: () => uniform(0) });
    expect(() => material.noteOn(60, { velocity: 0.8 })).toThrow(AudioMaterialNotBoundError);
  });

  it('holds two notes and retriggers the same pitch', () => {
    const material = new AudioMaterial({
      name: 'Pluck',
      polyphony: 2,
      voiceStealing: 'oldest',
      graph: () => uniform(0),
    });
    const a = fakeVoice();
    const b = fakeVoice();
    material.attachVoices([a, b]);
    material.noteOn(60, { velocity: 0.8 });
    material.noteOn(64, { velocity: 0.6 });
    expect(material.voices.map((v) => v.note)).toEqual([60, 64]);
    material.noteOn(60, { velocity: 1 });
    expect(a.events).toEqual(['on:60:0.8', 'off', 'on:60:1']);
    expect(b.events).toEqual(['on:64:0.6']);
    material.noteOff(60);
    expect(material.voices[0]!.held).toBe(false);
    expect(material.voices[0]!.note).toBe(60);
  });

  it('steals the oldest held voice when the pool is full', () => {
    const material = new AudioMaterial({ name: 'Pluck', polyphony: 2, voiceStealing: 'oldest', graph: () => uniform(0) });
    const a = fakeVoice();
    const b = fakeVoice();
    material.attachVoices([a, b]);
    material.noteOn(60);
    material.noteOn(64);
    material.noteOn(67);
    expect(material.voices.map((v) => v.note)).toEqual([67, 64]);
    expect(a.events.at(-1)).toBe('on:67:1');
  });

  it('fans setParam to every backend', () => {
    const material = new AudioMaterial({
      name: 'Pluck',
      params: { cutoff: { kind: 'range', min: 200, max: 8000, default: 2000 } },
      graph: () => uniform(0),
    });
    const a = fakeVoice();
    material.attachVoices([a]);
    material.setParam('cutoff', 400);
    expect(a.events).toContain('p:cutoff=400');
  });
});
