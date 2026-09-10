import { describe, expect, it } from 'vitest';
import { findMidiInput, findMidiOutput, listMidiPorts, listenMidiInput } from '../../src/midi/webMidi';

describe('listMidiPorts', () => {
  it('names inputs and outputs without inventing a default device', () => {
    const ports = listMidiPorts({
      inputs: [{ id: 'in-a', name: 'Keys', onmidimessage: null }],
      outputs: [{ id: 'out-b', name: 'Synth', send: () => {} }],
    });
    expect(ports).toEqual([
      { id: 'in-a', name: 'Keys', direction: 'input' },
      { id: 'out-b', name: 'Synth', direction: 'output' },
    ]);
  });

  it('picks a port by id, or the first one when id is empty', () => {
    const access = {
      inputs: [
        { id: 'in-a', name: 'A', onmidimessage: null },
        { id: 'in-b', name: 'B', onmidimessage: null },
      ],
      outputs: [{ id: 'out-z', name: 'Z', send: () => {} }],
    };
    expect(findMidiInput(access, 'in-b')?.id).toBe('in-b');
    expect(findMidiInput(access, null)?.id).toBe('in-a');
    expect(findMidiOutput(access, 'missing')).toBeNull();
    expect(findMidiOutput(access, null)?.id).toBe('out-z');
  });

  it('reads Map-style Web MIDI access the way the browser ships it', () => {
    const access = {
      inputs: new Map([['in-a', { id: 'in-a', name: 'A', onmidimessage: null }]]),
      outputs: new Map([['out-z', { id: 'out-z', name: 'Z', send: () => {} }]]),
    };
    expect(listMidiPorts(access)).toEqual([
      { id: 'in-a', name: 'A', direction: 'input' },
      { id: 'out-z', name: 'Z', direction: 'output' },
    ]);
  });
});

describe('listenMidiInput', () => {
  it('fans two listeners on one port and clears the handler when the last one leaves', () => {
    const input = { id: 'in-a', name: 'A', onmidimessage: null as ((event: { data: Uint8Array }) => void) | null };
    const a: number[] = [];
    const b: number[] = [];
    const offA = listenMidiInput(input, (data) => a.push(data[1]!));
    const offB = listenMidiInput(input, (data) => b.push(data[1]!));
    input.onmidimessage?.({ data: Uint8Array.from([0x90, 60, 100]) });
    offA();
    input.onmidimessage?.({ data: Uint8Array.from([0x90, 64, 100]) });
    offB();
    expect(a).toEqual([60]);
    expect(b).toEqual([60, 64]);
    expect(input.onmidimessage).toBeNull();
  });
});
