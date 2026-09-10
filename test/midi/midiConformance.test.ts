/**
 * Is `fixtures/midi-conformance.json` still a description of this code?
 *
 * The same job `asl/conformanceFixture.test.ts` does for the interpreter, for
 * the host jacks. Without it: the convertor's retrigger rule changes, the unit
 * tests in `midiIo.test.ts` are updated to match, the fixture is not
 * regenerated, and the Swift suite reports agreement against the rule as it
 * used to be.
 *
 * The host jacks needed this more than the node kinds did, not less. A node
 * kind that drifts is caught by 86 rendered graphs. Until this file existed,
 * the only thing holding two implementations of "gate owns length, trig is
 * the event" together was a paragraph in a handoff.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MIDI_CONFORMANCE_FIXTURE_VERSION,
  buildMidiConformanceFixture,
  midiFixtureStamp,
  type MidiConformanceFixture,
} from '../../src/midi/midiConformance';
import { MIDI_IN_OUTPUTS, MIDI_MESSAGE_NAMES, MIDI_OUT_INPUTS } from '../../src/midi/midiIo';
import { DEFAULT_PATCH_IO } from '../../src/patcher/flattenPatch';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/midi-conformance.json', import.meta.url));

const REGENERATE = 'npm run fixtures:midi (from web-version/)';

function loadFixture(): MidiConformanceFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MidiConformanceFixture;
}

describe('midi conformance fixture', () => {
  const onDisk = loadFixture();
  const rebuilt = buildMidiConformanceFixture();

  it('is not stale', () => {
    expect(
      onDisk.stamp,
      `fixtures/midi-conformance.json no longer describes this code, so any ` +
        `other implementation of the MIDI jacks is being held to an older ` +
        `contract and will pass regardless. Regenerate it: ${REGENERATE}`,
    ).toBe(rebuilt.stamp);
  });

  it('names the cases that changed, when it is stale', () => {
    // A stamp mismatch is one bit of information and the next question is
    // always "which case".
    const changed: string[] = [];
    for (const family of ['parse', 'monitor', 'output', 'encode', 'outlets', 'inlets'] as const) {
      const before = new Map(onDisk[family].map((entry) => [entry.name, entry]));
      const after = new Map(rebuilt[family].map((entry) => [entry.name, entry]));
      for (const [name, entry] of after) {
        if (JSON.stringify(before.get(name)) !== JSON.stringify(entry)) changed.push(`${family}/${name}`);
      }
      for (const name of before.keys()) if (!after.has(name)) changed.push(`${family}/${name} (removed)`);
    }
    const scalarsChanged = JSON.stringify(onDisk.scalars) !== JSON.stringify(rebuilt.scalars);
    expect({ changed, scalarsChanged }).toEqual({ changed: [], scalarsChanged: false });
  });

  it('is self-consistent, so a hand-edited fixture is refused', () => {
    // The one file in this pair where editing the evidence looks exactly like
    // fixing the bug.
    expect(midiFixtureStamp(onDisk)).toBe(onDisk.stamp);
  });

  it('is a format this build understands', () => {
    expect(onDisk.version).toBe(MIDI_CONFORMANCE_FIXTURE_VERSION);
  });

  it('states the whole jack vocabulary, not only the exercised part', () => {
    // What the Swift side checks its own jack names against. If this drifted
    // from midiIo.ts the cross-language check would compare Swift to a stale
    // list and call it agreement.
    expect(onDisk.inOutputs).toEqual([...MIDI_IN_OUTPUTS]);
    expect(onDisk.outInputs).toEqual([...MIDI_OUT_INPUTS]);
    expect(onDisk.messageNames).toEqual([...MIDI_MESSAGE_NAMES]);
    expect(onDisk.ioKinds).toEqual({ ...DEFAULT_PATCH_IO });
  });

  it('exercises every jack the vocabulary names', () => {
    // A jack nobody patches in any case is a jack no implementation is held
    // to. `cv` and `velocity` in particular are easy to leave untested and
    // easy to get wrong, since one is a pitch source and the other is not.
    const patched = new Set<string>();
    for (const entry of onDisk.output) {
      for (const [jack, on] of Object.entries(entry.cables)) if (on) patched.add(jack);
    }
    expect([...onDisk.outInputs].filter((jack) => !patched.has(jack))).toEqual([]);
  });

  it('exercises every message kind', () => {
    const messages = new Set(onDisk.output.map((entry) => entry.fields.message));
    expect([...messages].sort()).toEqual([0, 1, 2]);
  });

  it('states the trig width and the unpatched tick', () => {
    // Both were editor-local constants. A host that guessed the pulse width
    // would emit an edge too short for its own control rate to see, and a host
    // that guessed the unpatched note would emit pitch 0.
    expect(onDisk.trigSeconds).toBeGreaterThan(0);
    expect(onDisk.trigSeconds).toBe(rebuilt.trigSeconds);
    expect(onDisk.emptySample.note).toBe(60);
    expect(onDisk.emptySample).toEqual(rebuilt.emptySample);
  });

  it('gives every MIDI In outlet a level in every case', () => {
    // A missing key here is an outlet a host would read as undefined, which
    // becomes NaN the moment it reaches a graph.
    for (const entry of onDisk.outlets) {
      for (const outlet of onDisk.inOutputs) {
        expect(Number.isFinite(entry.levels[outlet]), `${entry.name}/${outlet}`).toBe(true);
      }
    }
  });

  it('separates a missing reading from a reading of zero', () => {
    // The distinction the editor did not make: a cabled note inlet whose
    // source has produced nothing keeps middle C, and one actually reading
    // zero is pitch 0.
    const missing = onDisk.inlets.find((entry) => entry.name.includes('no reading keeps the default'));
    const zero = onDisk.inlets.find((entry) => entry.name.includes('zero, not the default'));
    expect(missing?.sample.note).toBe(60);
    expect(zero?.sample.note).toBe(0);
  });

  it('honours a pulse that neither mean nor peak can show', () => {
    // A looper wrap is one sample wide. A host that read only `mean` would
    // drop every one of them.
    const pulseOnly = onDisk.inlets.find((entry) => entry.name.includes('only visible as pulse'));
    expect(pulseOnly?.readings.trig?.peak).toBe(0);
    expect(pulseOnly?.sample.trig).toBe(1);
  });

  it('carries no host device id', () => {
    // Device ids name a port on one machine (`host/hostLocal.ts`). A fixture
    // that carried one would be asserting that a second implementation
    // reproduces this laptop's MIDI ports.
    for (const entry of onDisk.output) expect(entry.fields.deviceId).toBeNull();
    expect(onDisk.defaults.midiIn.deviceId).toBeNull();
    expect(onDisk.defaults.midiOut.deviceId).toBeNull();
  });

  it('records at least one emitted packet, so an implementation that emits nothing fails', () => {
    // An all-silent fixture would be satisfied by a convertor that returns an
    // empty array from every call, which is the most likely way for a port to
    // be wrong and still green.
    const packets = onDisk.output.flatMap((entry) => entry.ticks.flatMap((tick) => tick.bytes));
    expect(packets.length).toBeGreaterThan(15);
    for (const packet of packets) {
      expect(packet.length).toBeGreaterThanOrEqual(2);
      for (const byte of packet) expect(byte).toBeGreaterThanOrEqual(0);
      for (const byte of packet) expect(byte).toBeLessThanOrEqual(255);
    }
  });
});
