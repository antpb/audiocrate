/**
 * Per-port Web MIDI. `createWebMidiBridge` listens to every input at once.
 * MIDI In / MIDI Out nodes pick one device by id. Inject access in tests.
 *
 * Browser `MIDIInputMap` iterates as Map entries. Arrays in tests iterate as
 * ports. `midiPortValues` accepts both.
 */
import type { MidiPortInfo } from './midiIo';

export interface WebMidiOutputLike {
  id: string;
  name?: string;
  send: (data: Uint8Array) => void;
}

export interface WebMidiInputPortLike {
  id: string;
  name?: string;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

export interface WebMidiAccessPorts {
  inputs: Iterable<WebMidiInputPortLike> | { values(): Iterable<WebMidiInputPortLike> };
  outputs?: Iterable<WebMidiOutputLike> | { values(): Iterable<WebMidiOutputLike> };
}

export function midiPortValues<T>(ports: { values(): Iterable<T> } | Iterable<T> | undefined): T[] {
  if (!ports) return [];
  const boxed = ports as { values?: () => Iterable<T> };
  if (typeof boxed.values === 'function') return [...boxed.values()];
  return [...(ports as Iterable<T>)];
}

export function listMidiPorts(access: WebMidiAccessPorts): MidiPortInfo[] {
  const ports: MidiPortInfo[] = [];
  for (const input of midiPortValues(access.inputs)) {
    ports.push({ id: input.id, name: input.name || 'MIDI Input', direction: 'input' });
  }
  for (const output of midiPortValues(access.outputs)) {
    ports.push({ id: output.id, name: output.name || 'MIDI Output', direction: 'output' });
  }
  return ports;
}

export function findMidiInput(access: WebMidiAccessPorts, id: string | null): WebMidiInputPortLike | null {
  const inputs = midiPortValues(access.inputs);
  if (id) return inputs.find((port) => port.id === id) ?? null;
  return inputs[0] ?? null;
}

export function findMidiOutput(access: WebMidiAccessPorts, id: string | null): WebMidiOutputLike | null {
  const outputs = midiPortValues(access.outputs);
  if (id) return outputs.find((port) => port.id === id) ?? null;
  return outputs[0] ?? null;
}

const midiInputFans = new WeakMap<WebMidiInputPortLike, Set<(data: Uint8Array) => void>>();

/**
 * Several MIDI In nodes may share one port. This fans out instead of
 * overwriting `onmidimessage`.
 */
export function listenMidiInput(
  input: WebMidiInputPortLike,
  listener: (data: Uint8Array) => void,
): () => void {
  let fans = midiInputFans.get(input);
  if (!fans) {
    fans = new Set();
    midiInputFans.set(input, fans);
    input.onmidimessage = (event) => {
      const raw = event.data;
      const data = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as ArrayLike<number>);
      for (const fn of fans!) fn(data);
    };
  }
  fans.add(listener);
  return () => {
    fans!.delete(listener);
    if (fans!.size === 0) {
      input.onmidimessage = null;
      midiInputFans.delete(input);
    }
  };
}

export async function requestMidiAccess(request?: () => Promise<WebMidiAccessPorts>): Promise<WebMidiAccessPorts> {
  if (request) return request();
  const nav = globalThis as { navigator?: { requestMIDIAccess?: () => Promise<WebMidiAccessPorts> } };
  if (!nav.navigator?.requestMIDIAccess) {
    throw new Error('Web MIDI is not available in this environment');
  }
  return nav.navigator.requestMIDIAccess();
}
