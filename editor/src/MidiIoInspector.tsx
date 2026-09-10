import {
  DEFAULT_MIDI_IN_FIELDS,
  DEFAULT_MIDI_OUT_FIELDS,
  MIDI_MESSAGE_NAMES,
  midiInputChannel,
  midiMessageIndex,
  midiOutputChannel,
  readMidiIoFields,
} from '../../src/index';
import { MidiDeviceSelect } from './MidiDeviceSelect';
import { RangeSlider } from './RangeSlider';

export function MidiIoInspector({
  kind,
  data,
  onChange,
  onRemove,
}: {
  kind: string;
  data: Record<string, unknown> | undefined;
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const isOut = kind === 'midiout';
  const fields = readMidiIoFields(data, isOut ? DEFAULT_MIDI_OUT_FIELDS : DEFAULT_MIDI_IN_FIELDS);
  const channel = isOut ? midiOutputChannel(fields.channel) : midiInputChannel(fields.channel);
  const message = midiMessageIndex(fields.message);

  return (
    <aside className="inspector">
      <header>
        <h2>{isOut ? 'MIDI Out' : 'MIDI In'}</h2>
        <span className="kind">{isOut ? 'output' : 'input'}</span>
        <button type="button" className="danger" onClick={onRemove}>
          Remove
        </button>
      </header>
      {isOut ? (
        <p className="hint">
          Gate is the held voice: rise sends Note On, fall sends Note Off. Trig is the event: a
          pulse plus a note fires Note On. If gate is also patched, trig retriggers only while
          gate is high. If gate is not patched, the note lasts until trig falls or width, whichever
          is later. The device is this machine&apos;s. Changing it does not update anyone else in
          a session. Channel and message do.
        </p>
      ) : (
        <p className="hint">
          Last-note analog, like Keyboard. cv is 1V/oct with A4 at 0V. note, gate, and velocity
          cables into an instrument allocate voices. This node listens to one device on this
          machine. That assignment is not sent to a session.
        </p>
      )}
      <MidiDeviceSelect
        deviceId={fields.deviceId}
        direction={isOut ? 'output' : 'input'}
        onChange={(id) => onChange({ ...fields, deviceId: id ?? '' })}
      />
      <label className="param">
        <span>Channel</span>
        <select
          value={channel}
          onChange={(event) => onChange({ ...fields, channel: Number(event.target.value) })}
        >
          {isOut ? null : <option value={0}>Omni</option>}
          {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {isOut ? (
        <>
          <label className="param">
            <span>Message</span>
            <select
              value={message}
              onChange={(event) => onChange({ ...fields, message: Number(event.target.value) })}
            >
              {MIDI_MESSAGE_NAMES.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {message === 1 ? (
            <label className="param">
              <span>
                CC
                <em>{Math.round(fields.cc)}</em>
              </span>
              <RangeSlider
                min={0}
                max={127}
                step={1}
                value={fields.cc}
                onChange={(event) => onChange({ ...fields, cc: Number(event.target.value) })}
              />
            </label>
          ) : null}
          {message === 0 ? (
            <label className="param">
              <span>
                Width
                <em>{fields.widthSec.toFixed(3)} s</em>
              </span>
              <RangeSlider
                min={0.005}
                max={0.5}
                step={0.005}
                value={fields.widthSec}
                onChange={(event) => onChange({ ...fields, widthSec: Number(event.target.value) })}
              />
            </label>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
