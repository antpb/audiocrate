import { RangeSlider } from './RangeSlider';
import {
  midiClipStats,
  readMidiClipFields,
  readMidiNotes,
  type MidiClipFields,
} from './midiClipData';

export function MidiClipInspector({
  data,
  onChange,
  onRemove,
}: {
  data: Record<string, unknown> | undefined;
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const fields = readMidiClipFields(data);
  const notes = readMidiNotes(data);
  const stats = midiClipStats(notes);
  const set = (patch: Partial<MidiClipFields>) => {
    onChange({
      start: patch.start ?? fields.start,
      rate: patch.rate ?? fields.rate,
      transpose: patch.transpose ?? fields.transpose,
      velocity: patch.velocity ?? fields.velocity,
      loop: (patch.loop ?? fields.loop) ? 1 : 0,
      loops: patch.loops ?? fields.loops,
      offsetSec: patch.offsetSec ?? fields.offsetSec,
    });
  };
  const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`);

  return (
    <aside className="inspector">
      <header>
        <h2>MIDI Clip</h2>
        <span className="kind">timeline</span>
        <button type="button" className="danger" onClick={onRemove}>
          Remove
        </button>
      </header>
      <p className="hint">
        Start, loop, pitch, rate, and level, same as Sample Player. Play sends notes on the note/gate cables.
        Stop and Play to hear a change.
      </p>
      <p className="key-live">
        {stats.notes === 0
          ? 'No notes'
          : `${stats.notes} notes · ${stats.low}-${stats.high} · ${stats.beats.toFixed(1)} beats`}
      </p>
      <label className="param">
        <span>
          Start
          <em>{(fields.start * 100).toFixed(0)}%</em>
        </span>
        <RangeSlider
          min={0}
          max={1}
          step={0.001}
          value={fields.start}
          onChange={(event) => set({ start: Number(event.target.value) })}
        />
      </label>
      <label className="param">
        <span>
          Rate
          <em>{fields.rate.toFixed(2)}×</em>
        </span>
        <RangeSlider
          min={0.25}
          max={4}
          step={0.01}
          value={fields.rate}
          onChange={(event) => set({ rate: Number(event.target.value) })}
        />
      </label>
      <label className="param">
        <span>
          Pitch
          <em>{signed(fields.transpose)} st</em>
        </span>
        <RangeSlider
          min={-12}
          max={12}
          step={1}
          value={fields.transpose}
          onChange={(event) => set({ transpose: Number(event.target.value) })}
        />
      </label>
      <label className="param">
        <span>
          Velocity
          <em>{fields.velocity.toFixed(2)}</em>
        </span>
        <RangeSlider
          min={0}
          max={2}
          step={0.01}
          value={fields.velocity}
          onChange={(event) => set({ velocity: Number(event.target.value) })}
        />
      </label>
      <label className="param row">
        <span>Loop</span>
        <input
          type="checkbox"
          checked={fields.loop}
          onChange={(event) => set({ loop: event.target.checked, loops: event.target.checked ? Math.max(2, fields.loops) : fields.loops })}
        />
      </label>
      {fields.loop ? (
        <label className="param">
          <span>
            Repeats
            <em>{fields.loops}</em>
          </span>
          <RangeSlider
            min={1}
            max={8}
            step={1}
            value={fields.loops}
            onChange={(event) => set({ loops: Number(event.target.value) })}
          />
        </label>
      ) : null}
      <label className="param">
        <span>
          Offset
          <em>{fields.offsetSec.toFixed(2)} s</em>
        </span>
        <RangeSlider
          min={0}
          max={Math.max(180, fields.offsetSec)}
          step={0.01}
          value={fields.offsetSec}
          onChange={(event) => set({ offsetSec: Number(event.target.value) })}
        />
      </label>
    </aside>
  );
}
