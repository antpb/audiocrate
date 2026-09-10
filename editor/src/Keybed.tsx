import { useEffect, useState } from 'react';
import type { PointerEvent } from 'react';
import { noteName } from '../../src/index';
import type { AnalogKeyboard, AnalogSnapshot } from './analogKeyboard';
import { displayedOctaves, whiteKeys } from './keybedLayout';
import { RangeSlider } from './RangeSlider';
import { VoiceStrip } from './VoiceStrip';

const BLACK_AFTER = new Set([0, 2, 5, 7, 9]);

interface KeybedProps {
  analog: AnalogKeyboard;
  snapshot: AnalogSnapshot;
  onPress: (note: number) => void;
  onRelease: (note: number) => void;
  onOctave: (octave: number) => void;
  onVelocity: (velocity: number) => void;
}

export function Keybed({ analog, snapshot, onPress, onRelease, onOctave, onVelocity }: KeybedProps) {
  const octaves = useDisplayedOctaves();
  const start = analog.midiForDegree(0);
  const whites = whiteKeys(start, octaves);

  return (
    <footer className="keybed">
      <div className="keybed-meta">
        {/* <span className="keybed-title">Keybed</span> */}
        <span className="keybed-readout">
          cv last {noteName(snapshot.note)} · {snapshot.cv.toFixed(2)} V · gate {snapshot.gate ? 'high' : 'low'}
        </span>
        <label className="keybed-vel">
          Vel
          <RangeSlider
            min={0}
            max={1}
            step={0.01}
            value={analog.velocity}
            onChange={(event) => onVelocity(Number(event.target.value))}
          />
        </label>
        <button type="button" onClick={() => onOctave(analog.octave - 1)} disabled={analog.octave <= 1}>
          Oct -
        </button>
        <span className="keybed-oct">C{analog.octave}</span>
        <button type="button" onClick={() => onOctave(analog.octave + 1)} disabled={analog.octave >= 7}>
          Oct +
        </button>
        <span className="keybed-hint">A-K computer keys · Z/X octave</span>
      </div>
      <VoiceStrip snapshot={snapshot} />
      <div className="keys">
        {whites.map((midi, index) => {
          const black = BLACK_AFTER.has((midi - start) % 12) && index < whites.length - 1 ? midi + 1 : null;
          return (
            <div key={midi} className="key-slot">
              <button
                type="button"
                className={`key white${snapshot.held.includes(midi) ? ' down' : ''}`}
                onPointerDown={(event) => hold(event, midi, onPress)}
                onPointerUp={() => onRelease(midi)}
                onPointerCancel={() => onRelease(midi)}
              >
                {midi % 12 === 0 ? noteName(midi) : ''}
              </button>
              {black != null ? (
                <button
                  type="button"
                  className={`key black${snapshot.held.includes(black) ? ' down' : ''}`}
                  onPointerDown={(event) => hold(event, black, onPress)}
                  onPointerUp={() => onRelease(black)}
                  onPointerCancel={() => onRelease(black)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </footer>
  );
}

function useDisplayedOctaves(): number {
  const [octaves, setOctaves] = useState(() =>
    typeof window === 'undefined' ? 2 : displayedOctaves(window.innerWidth),
  );
  useEffect(() => {
    const apply = () => setOctaves(displayedOctaves(window.innerWidth));
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);
  return octaves;
}

function hold(event: PointerEvent<HTMLButtonElement>, note: number, onPress: (note: number) => void): void {
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  onPress(note);
}
