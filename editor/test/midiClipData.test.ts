import { describe, expect, it } from 'vitest';
import { midiClipStats, placeMidiClip, readMidiClipFields } from '../src/midiClipData';

const clip = {
  offsetSec: 8,
  bars: 2,
  notes: [
    { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 },
    { pitch: 64, startBeat: 4, durationBeats: 1, velocity: 0.5 },
    { pitch: 67, startBeat: 7, durationBeats: 1, velocity: 1 },
  ],
};

describe('midi clip fields', () => {
  it('defaults match a one-shot sample player', () => {
    expect(readMidiClipFields(clip)).toEqual({
      offsetSec: 8,
      start: 0,
      rate: 1,
      transpose: 0,
      velocity: 1,
      loop: false,
      loops: 4,
    });
  });

  it('transposes, scales velocity, and keeps timeline offset', () => {
    const placed = placeMidiClip({ ...clip, transpose: 12, velocity: 0.5 });
    expect(placed.offsetSec).toBe(8);
    expect(placed.notes.map((note) => note.pitch)).toEqual([72, 76, 79]);
    expect(placed.notes[0]?.velocity).toBeCloseTo(0.4);
  });

  it('start skips the beginning of the roll the way Sample Player start does', () => {
    const placed = placeMidiClip({ ...clip, start: 0.5 });
    expect(placed.notes.map((note) => note.pitch)).toEqual([64, 67]);
    expect(placed.notes[0]?.startBeat).toBeCloseTo(0);
  });

  it('rate 2 plays the clip in half the beats', () => {
    const placed = placeMidiClip({ ...clip, rate: 2 });
    expect(placed.notes[1]?.startBeat).toBeCloseTo(2);
    expect(placed.notes[1]?.durationBeats).toBeCloseTo(0.5);
  });

  it('loop tiles the window', () => {
    const placed = placeMidiClip({ ...clip, loop: 1, loops: 2, start: 0.5 });
    expect(placed.notes.map((note) => note.pitch)).toEqual([64, 67, 64, 67]);
    expect(placed.notes[2]?.startBeat).toBeCloseTo(4);
  });

  it('summarizes the roll', () => {
    expect(midiClipStats(clip.notes)).toMatchObject({ notes: 3, low: 'C4', high: 'G4' });
  });
});
