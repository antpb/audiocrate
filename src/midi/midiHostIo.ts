/**
 * Driving a MIDI In or MIDI Out node from a host graph.
 *
 * `midiIo.ts` is the convertor: bytes in, an analog snapshot out, and a tick
 * of cabled values back out as bytes. This file is the layer immediately
 * around it, and it exists because that layer was written once, in
 * `editor/src/audio.ts`, which `package.json` does not publish. A host that
 * grows these nodes therefore had to reinvent it: what a MIDI In outlet reads
 * before any key is touched, whether a `gate` inlet is a level or an edge, how
 * long a `trig` pulse lasts. Three implementations of that would disagree, and
 * the disagreement is a stuck note.
 *
 * Nothing here touches an audio API. The editor drives `ConstantSourceNode`s
 * with these numbers and a React Native host drives whatever it has; the
 * numbers are the part that has to match.
 */
import {
  MIDI_OUT_INPUTS,
  midiInletGate,
  midiInletValue,
  type MidiInOutput,
  type MidiInputSnapshot,
  type MidiOutInput,
  type MidiOutputCables,
  type MidiOutputSample,
} from './midiIo';

/**
 * How long a `trig` outlet stays high, in seconds.
 *
 * A note press is an instant and a graph reads levels, so the pulse has to
 * have a width. 8 ms is long enough to survive a control tick at any block
 * size a host is likely to use and short enough that two fast repeated notes
 * are still two edges rather than one held gate.
 */
export const MIDI_TRIG_SECONDS = 0.008;

/**
 * What a MIDI Out node reads from one cabled inlet.
 *
 * `mean` and `peak` are the interval statistics a `meter` tap keeps. `pulse`
 * is the host saying a one-sample event happened since the last tick and may
 * therefore be invisible in both: a looper wrap or a clock edge can be a
 * single sample wide, and an interval mean over a block will not see it.
 */
export interface MidiInletReading {
  mean: number;
  peak: number;
  pulse?: boolean;
}

export function emptyMidiCables(): MidiOutputCables {
  return { note: false, cv: false, gate: false, trig: false, velocity: false, cc: false };
}

/**
 * An unpatched MIDI Out tick.
 *
 * `note` is 60 rather than 0 because an unpatched pitch has to be *some* note
 * and middle C is the one a person expects; 0 is an inaudible sub-bass C that
 * reads as a broken patch. Everything else is silence.
 */
export function emptyMidiSample(): MidiOutputSample {
  return { note: 60, cv: 0, gate: 0, trig: 0, velocity: 0, cc: 0 };
}

/**
 * The six MIDI In outlets, as levels, for a monitor snapshot.
 *
 * `trig` is always 0 here. It is an edge, not a level: the host raises it for
 * `MIDI_TRIG_SECONDS` when `MidiInputMonitor.apply` reports a press and lowers
 * it again. Returning a level for it would make a held key look like a
 * continuous retrigger.
 *
 * With no snapshot at all (no device bound, nothing pressed yet) the outlets
 * read the same as a released keyboard rather than being left undefined, so a
 * graph patched to a MIDI In that nobody has played is silent and in tune
 * instead of silent and at note 0.
 */
export function midiInOutlets(snapshot: MidiInputSnapshot | undefined): Record<MidiInOutput, number> {
  return {
    cv: snapshot?.cv ?? 0,
    gate: snapshot?.gate ?? 0,
    trig: 0,
    velocity: snapshot?.velocity ?? 0,
    note: snapshot?.note ?? 60,
    cc: snapshot?.cc ?? 0,
  };
}

/**
 * One MIDI Out tick, gathered from whatever the host has cabled into it.
 *
 * The rule that must not diverge: **`gate` and `trig` are edges and everything
 * else is a value.** A gate read as a mean would open at 0.5 and a note read
 * as a gate would collapse 127 pitches into on and off.
 *
 * An inlet with no cable is never read at all, because "no cable" and "a cable
 * sitting at zero" are different: an unpatched gate means the trig owns note
 * length, and a patched gate at zero means the voice is off. `stepMidiOutput`
 * branches on exactly that distinction.
 *
 * A cabled inlet whose source has produced no reading yet keeps the default
 * too. That is a deliberate difference from the editor this was lifted out of,
 * which passed the missing reading straight through and so gathered `note` as
 * 0 for as long as the source stayed silent. Zero is the inaudible sub-bass C
 * that `emptyMidiSample` exists to avoid, and a patch cabled to a source that
 * has not started should sound like an unpatched one, not like a broken one.
 * For `gate` and `trig` the default is 0, so nothing changes there.
 */
export function midiOutSample(
  cables: MidiOutputCables,
  read: (inlet: MidiOutInput) => MidiInletReading | undefined,
): MidiOutputSample {
  const sample = emptyMidiSample();
  for (const inlet of MIDI_OUT_INPUTS) {
    if (!cables[inlet]) continue;
    const jack = read(inlet);
    if (!jack) continue;
    sample[inlet] = inlet === 'gate' || inlet === 'trig' ? midiInletGate(jack) : midiInletValue(jack);
  }
  return sample;
}
