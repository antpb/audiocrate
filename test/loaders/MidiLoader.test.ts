import { describe, expect, it } from 'vitest';
import { createWebMidiBridge, decodeMidi, encodeMidi, midiFileToClips } from '../../src/loaders/MidiLoader';
import type { MidiFile } from '../../src/loaders/MidiLoader';

function smf(file: MidiFile) {
  return decodeMidi(encodeMidi(file));
}

describe('MidiLoader SMF', () => {
  it('round-trips notes, names, and ticks-per-quarter', () => {
    const decoded = smf({
      format: 1,
      ticksPerQuarter: 480,
      tempoBpm: 120,
      timeSigN: 4,
      timeSigD: 4,
      tracks: [
        {
          name: 'Lead',
          notes: [
            { pitch: 60, velocity: 0.8, startBeat: 0, durationBeats: 1, channel: 0 },
            { pitch: 64, velocity: 0.5, startBeat: 1, durationBeats: 0.5, channel: 0 },
          ],
        },
      ],
    });
    expect(decoded.ticksPerQuarter).toBe(480);
    expect(decoded.tracks[0]!.name).toBe('Lead');
    expect(decoded.tracks[0]!.notes).toHaveLength(2);
    expect(decoded.tracks[0]!.notes[0]).toMatchObject({ pitch: 60, startBeat: 0, durationBeats: 1 });
    expect(decoded.tracks[0]!.notes[1]).toMatchObject({ pitch: 64, startBeat: 1, durationBeats: 0.5 });
  });

  it('reads running status and note-on velocity 0 as note-off', () => {
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
      0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x0b,
      0x00, 0x90, 0x3c, 0x40,
      0x60, 0x3c, 0x00,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const file = decodeMidi(bytes);
    expect(file.tracks[0]!.notes).toHaveLength(1);
    expect(file.tracks[0]!.notes[0]).toMatchObject({ pitch: 60, startBeat: 0, durationBeats: 1 });
  });

  it('reads set-tempo and time-signature metas', () => {
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
      0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x13,
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const file = decodeMidi(bytes);
    expect(file.tempoBpm).toBeCloseTo(120);
    expect(file.timeSigN).toBe(3);
    expect(file.timeSigD).toBe(4);
  });

  it('throws on a non-SMF header', () => {
    expect(() => decodeMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(TypeError);
  });

  it('maps non-empty tracks to MidiClips', () => {
    const clips = midiFileToClips({
      format: 1,
      ticksPerQuarter: 480,
      tempoBpm: 120,
      timeSigN: 4,
      timeSigD: 4,
      tracks: [
        { name: 'Empty', notes: [] },
        { name: 'Piano', notes: [{ pitch: 67, velocity: 1, startBeat: 0, durationBeats: 2 }] },
      ],
    });
    expect(clips).toHaveLength(1);
    expect(clips[0]!.name).toBe('Piano');
    expect(clips[0]!.notes[0]!.pitch).toBe(67);
  });

  it('collects CC into clip lanes', () => {
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
      0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x0c,
      0x00, 0xb0, 0x4a, 0x40,
      0x60, 0xb0, 0x4a, 0x7f,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const file = decodeMidi(bytes);
    expect(file.tracks[0]!.ccLanes).toEqual([
      {
        cc: 74,
        channel: 0,
        points: [
          { startBeat: 0, value: 64 },
          { startBeat: 1, value: 127 },
        ],
      },
    ]);
  });
});

describe('createWebMidiBridge', () => {
  it('routes note-on / note-off through an injected access', async () => {
    const input = { id: 'in-1', name: 'Pad', onmidimessage: null as ((event: { data: Uint8Array }) => void) | null };
    const hits: Array<[string, number]> = [];
    const ccHits: Array<[number, number]> = [];
    const bridge = createWebMidiBridge({
      requestMIDIAccess: async () => ({ inputs: [input] }),
    });
    await bridge.connect({
      noteOn: (note) => hits.push(['on', note]),
      noteOff: (note) => hits.push(['off', note]),
      controlChange: (cc, value) => ccHits.push([cc, value]),
    });
    expect(bridge.connected).toBe(true);
    input.onmidimessage?.({ data: Uint8Array.from([0x90, 64, 100]) });
    input.onmidimessage?.({ data: Uint8Array.from([0x80, 64, 0]) });
    input.onmidimessage?.({ data: Uint8Array.from([0xb0, 74, 90]) });
    expect(hits).toEqual([
      ['on', 64],
      ['off', 64],
    ]);
    expect(ccHits).toEqual([[74, 90]]);
    bridge.disconnect();
    expect(bridge.connected).toBe(false);
    expect(input.onmidimessage).toBeNull();
  });
});
