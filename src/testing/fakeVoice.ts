/**
 * A do-nothing `VoiceHandle`, for tests that need one but are not testing it.
 *
 * `AudioWorkletNode` does not exist in Node, so every test touching live
 * voices builds a fake. There were four, hand-written, and each time
 * `VoiceHandle` grew a method all four silently fell out of date until
 * `tsc --noEmit` started running. Spreading one base means the interface has
 * exactly one place to be satisfied, and a test still overrides whatever it
 * actually asserts on.
 */
import type { VoiceHandle } from '../renderers/WebAudioRenderer';

/** Everything but `node`, which every caller supplies its own stub for. */
export const fakeVoiceDefaults: Omit<VoiceHandle, 'node'> = {
  auxInputs: [],
  inputIndexFor: (name: string) => {
    if (name !== 'input') throw new RangeError(`no audio input "${name}"`);
    return 0;
  },
  noteOn: () => {},
  noteOff: () => {},
  setParam: () => {},
  loadKernel: async () => {},
  sendKernel: () => {},
  midiNoteOn: () => {},
  midiNoteOff: () => {},
  midiControlChange: () => {},
  allNotesOff: () => {},
  setHostBpm: () => {},
  setTransport: () => {},
  setAnalysisInterval: () => {},
  onAnalysis: () => () => {},
};

/** `node` plus the defaults plus whatever this test cares about. */
export function fakeVoiceHandle(
  node: VoiceHandle['node'],
  overrides: Partial<VoiceHandle> = {},
): VoiceHandle {
  return { node, ...fakeVoiceDefaults, ...overrides };
}
