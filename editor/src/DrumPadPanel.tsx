import { useRef, useState } from 'react';
import { noteName, type InspectorControl } from '../../src/index';
import { FACTORY_PAD_LABELS, FACTORY_PAD_SAMPLES } from '../../examples/drum/src/index';
import { AssetSlot } from './AssetSlot';
import { InspectorControlRow } from './ControlGroups';

const PADS = 16;
/** Pad 0 is C2. `padIndex = note - 36`, the same arithmetic the AU does. */
const BASE_NOTE = 36;

/** Bottom row first, the way a pad grid is laid out under your hands. */
const GRID_ROWS = [
  [12, 13, 14, 15],
  [8, 9, 10, 11],
  [4, 5, 6, 7],
  [0, 1, 2, 3],
];

const PAD_CONTROLS: readonly { name: string; label: string }[] = [
  { name: 'Vol', label: 'Level' },
  { name: 'Pan', label: 'Pan' },
  { name: 'Pitch', label: 'Pitch' },
  { name: 'SampleStart', label: 'Start' },
  { name: 'SRate', label: 'Sample Rate' },
  { name: 'Bits', label: 'Bits' },
  { name: 'Cut', label: 'Cutoff' },
  { name: 'Res', label: 'Resonance' },
];

/**
 * Declared so a kit round-trips and read by nothing. Grouped and labelled
 * rather than hidden, because a control that silently does nothing is worse
 * than one that says so.
 */
const CARRIED_CONTROLS: readonly { name: string; label: string }[] = [
  { name: 'SampleStop', label: 'Stop' },
  { name: 'SampleFadeIn', label: 'Fade In' },
  { name: 'SampleFadeOut', label: 'Fade Out' },
  { name: 'StretchOn', label: 'Stretch' },
  { name: 'StretchAmt', label: 'Stretch Amount' },
  { name: 'Character', label: 'Character' },
  { name: 'HumanizeExempt', label: 'Humanize Exempt' },
];

const MASTER_CONTROLS: readonly { name: string; label: string }[] = [
  { name: 'masterCut', label: 'Cutoff' },
  { name: 'masterRes', label: 'Resonance' },
  { name: 'masterIRMix', label: 'Character' },
  { name: 'masterVol', label: 'Level' },
  { name: 'masterBypassPadDSP', label: 'Bypass 026S' },
];

interface DrumPadPanelProps {
  controls: readonly InspectorControl[];
  onParam: (name: string, value: number) => void;
  padFilenames: readonly (string | null)[];
  onPadFile?: (pad: number, file: File) => Promise<void>;
  onPadClear?: (pad: number) => void;
  onPadTrigger?: (note: number) => void;
  onPadRelease?: (note: number) => void;
}

/**
 * What is silkscreened on the cap.
 *
 * A pad still holding its factory sample reads as the drum it is, the way the
 * plugin's own face does. Anything else reads as the file, minus the shared
 * `homecrate_` prefix that would otherwise be all sixteen caps had room for.
 */
function capLabel(filename: string | null, pad: number): string {
  if (!filename) return FACTORY_PAD_LABELS[pad] ?? 'empty';
  if (filename === FACTORY_PAD_SAMPLES[pad]) return FACTORY_PAD_LABELS[pad] ?? filename;
  const base = filename
    .replace(/^.*[/\\]/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/^homecrate_/, '');
  return base.length > 10 ? `${base.slice(0, 9)}.` : base;
}

export function DrumPadPanel({
  controls,
  onParam,
  padFilenames,
  onPadFile,
  onPadClear,
  onPadTrigger,
  onPadRelease,
}: DrumPadPanelProps) {
  const [selected, setSelected] = useState(0);
  // Which pad this pointer is holding, so a release only ever ends the note
  // it started. Without it, dragging across the grid sends a note-off for
  // every pad the pointer passes over.
  const holding = useRef<number | null>(null);
  const byName = new Map(controls.map((control) => [control.name, control]));
  const note = BASE_NOTE + selected;

  const strike = (pad: number, event: { currentTarget: HTMLElement; pointerId: number }) => {
    setSelected(pad);
    holding.current = pad;
    // Captured, so a finger that slides off the cap still ends the note.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* not every pointer can be captured */
    }
    onPadTrigger?.(BASE_NOTE + pad);
  };

  const lift = (pad: number) => {
    if (holding.current !== pad) return;
    holding.current = null;
    onPadRelease?.(BASE_NOTE + pad);
  };

  const row = (name: string, label: string) => {
    const control = byName.get(name);
    if (!control) return null;
    return <InspectorControlRow key={name} control={control} onParam={onParam} label={label} />;
  };

  return (
    <div className="drum-panel">
      <p className="hint">
        Sixteen one-shots on C2 to D#3. A pad plays to its end and ignores the note-off. Patch a
        Keyboard or a MIDI Clip into note and gate to play it.
      </p>

      <div className="drum-grid">
        {GRID_ROWS.map((gridRow, index) => (
          <div key={index} className="drum-grid-row">
            {gridRow.map((pad) => (
              <button
                key={pad}
                type="button"
                className={`drum-pad${pad === selected ? ' on' : ''}${padFilenames[pad] ? ' loaded' : ''}`}
                onPointerDown={(event) => strike(pad, event)}
                onPointerUp={() => lift(pad)}
                onPointerCancel={() => lift(pad)}
              >
                <span className="drum-pad-note">{noteName(BASE_NOTE + pad)}</span>
                <span className="drum-pad-name">{capLabel(padFilenames[pad] ?? null, pad)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="eq-bands">
        <section className="eq-band">
          <h3>
            {FACTORY_PAD_LABELS[selected] ?? `Pad ${selected}`} <em>{noteName(note)}</em>
          </h3>
          {onPadFile ? (
            <AssetSlot
              label="Sample"
              filename={padFilenames[selected] ?? null}
              accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a"
              onChoose={(file) => onPadFile(selected, file)}
              onClear={() => onPadClear?.(selected)}
            />
          ) : null}
          {PAD_CONTROLS.map((control) => row(`pad${selected}${control.name}`, control.label))}
        </section>

        <section className="eq-band">
          <h3>Master</h3>
          <p className="hint">
            An 18 dB/oct low-pass across the whole kit, then the character filter. Character is the
            plugin&apos;s own impulse response, which is that same cascade at 17 kHz, so it runs as a
            filter rather than a convolution.
          </p>
          {MASTER_CONTROLS.map((control) => row(control.name, control.label))}
          {row('masterHumanize', 'Humanize')}
        </section>

        <section className="eq-band">
          <h3>Saved, not played</h3>
          <p className="hint">
            These live in the plugin&apos;s sampler rather than in its DSP: the time stretch is an
            offline pass and the rest perturb timing and velocity at note-on. They are kept so a kit
            survives a round trip, and nothing here reads them.
          </p>
          {CARRIED_CONTROLS.map((control) => row(`pad${selected}${control.name}`, control.label))}
        </section>
      </div>
    </div>
  );
}
