import { describe, expect, it } from 'vitest';
import { NUM_PADS, PAD_BASE_NOTE, drumLiveNote, padIndexFromNote } from './drumParams';

describe('padIndexFromNote', () => {
  it('maps C2 through D#3 onto pads 0..15', () => {
    for (let pad = 0; pad < NUM_PADS; pad++) {
      expect(padIndexFromNote(PAD_BASE_NOTE + pad)).toBe(pad);
    }
  });

  it('treats 0..15 as a pad index, the way some project MIDI writes it', () => {
    expect(padIndexFromNote(0)).toBe(0);
    expect(padIndexFromNote(7)).toBe(7);
    expect(padIndexFromNote(15)).toBe(15);
  });

  it('wraps the default C4 keybed onto the same 16 pads', () => {
    expect(padIndexFromNote(60)).toBe((60 - PAD_BASE_NOTE) % NUM_PADS);
    expect(padIndexFromNote(36)).toBe(0);
    expect(padIndexFromNote(72)).toBe((72 - PAD_BASE_NOTE) % NUM_PADS);
  });

  it('rejects notes outside MIDI', () => {
    expect(padIndexFromNote(-1)).toBeNull();
    expect(padIndexFromNote(128)).toBeNull();
    expect(padIndexFromNote(Number.NaN)).toBeNull();
  });

  it('rewrites a keybed C4 as the C2 pad the live graph compares', () => {
    expect(drumLiveNote(60)).toBe(PAD_BASE_NOTE + ((60 - PAD_BASE_NOTE) % NUM_PADS));
    expect(drumLiveNote(0)).toBe(PAD_BASE_NOTE);
    expect(drumLiveNote(36)).toBe(PAD_BASE_NOTE);
  });
});
