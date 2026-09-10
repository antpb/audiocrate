import {
  BUFFER_MS_OPTIONS,
  RENDER_BLOCK_OPTIONS,
  SAMPLE_RATE_OPTIONS,
  type AudioSettings,
} from './audioSettings';

interface AudioReadout {
  sampleRate: number | null;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  state: string;
}

interface SettingsPanelProps {
  open: boolean;
  settings: AudioSettings;
  readout: AudioReadout;
  onChange: (next: AudioSettings) => void;
  onReinitialize: () => void;
  onClose: () => void;
}

export function SettingsPanel({
  open,
  settings,
  readout,
  onChange,
  onReinitialize,
  onClose,
}: SettingsPanelProps) {
  if (!open) return null;
  return (
    <div className="settings-wrap">
      <button type="button" className="settings-dim" aria-label="Close settings" onClick={onClose} />
      <aside className="settings-drawer">
        <header className="settings-head">
          <h2>Audio</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="settings-body">
          <p className="hint">What the browser actually opened is on the line below.</p>
          <p className="settings-readout">
            {readout.sampleRate
              ? `${readout.sampleRate} Hz · ${formatMs(readout.baseLatencyMs)} buffer${
                  readout.outputLatencyMs != null ? ` · ${formatMs(readout.outputLatencyMs)} out` : ''
                } · ${readout.state}`
              : 'Device not open yet. Apply a setting or press Play.'}
          </p>
          {rateMismatch(settings.sampleRate, readout.sampleRate) ? (
            <p className="hint settings-warn">
              You asked for {formatRate(settings.sampleRate)}. The device opened {formatRate(readout.sampleRate)}.
              Clip speed follows the opened rate.
            </p>
          ) : null}
          {settings.bufferMs <= 3 ? (
            <p className="hint settings-warn">
              {settings.bufferMs}ms is for a single dry instrument. A song mix through inserts will
              stutter. Use 10ms or 20ms.
            </p>
          ) : null}

          <section>
            <h3>IO Buffer Duration</h3>
            <p className="hint">
              Lower values cut monitoring latency. A full mix needs 10ms or 20ms.
            </p>
            <div className="settings-pills">
              {BUFFER_MS_OPTIONS.map((ms) => (
                <button
                  key={ms}
                  type="button"
                  className={settings.bufferMs === ms ? 'on' : ''}
                  onClick={() => onChange({ ...settings, bufferMs: ms })}
                >
                  {ms}ms
                </button>
              ))}
            </div>
            <p className="hint">Default: 10ms</p>
          </section>

          <section>
            <h3>Sample Rate</h3>
            <p className="hint">
              Requested rate for a new AudioContext. The hardware can refuse and stay at its own
              rate.
            </p>
            <div className="settings-pills">
              <button
                type="button"
                className={settings.sampleRate == null ? 'on' : ''}
                onClick={() => onChange({ ...settings, sampleRate: null })}
              >
                Auto
              </button>
              {SAMPLE_RATE_OPTIONS.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  className={settings.sampleRate === rate ? 'on' : ''}
                  onClick={() => onChange({ ...settings, sampleRate: rate })}
                >
                  {rate === 44100 ? '44.1 kHz' : rate === 48000 ? '48 kHz' : '96 kHz'}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3>Render Block Size</h3>
            <p className="hint">
              NAM process size and the standalone IR hop. 64 ≈ 1.5 ms at 44.1 kHz. Auto is 256 for
              NAM and 512 for IR. Amp has no cabinet hop.
            </p>
            <div className="settings-pills">
              {RENDER_BLOCK_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={settings.renderBlock === option.frames ? 'on' : ''}
                  onClick={() => onChange({ ...settings, renderBlock: option.frames })}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {settings.renderBlock === 64 || settings.renderBlock === 128 ? (
              <p className="hint settings-warn">
                {settings.renderBlock} is the low-latency path. If playback crackles, step back to
                256 or Auto.
              </p>
            ) : null}
          </section>

          <section>
            <h3>Reinitialize Audio</h3>
            <p className="hint">
              Rebuilds the audio context. Use if sound garbles after changing devices.
            </p>
            <button type="button" onClick={onReinitialize}>
              Reinitialize Audio
            </button>
          </section>
        </div>
      </aside>
    </div>
  );
}

function rateMismatch(requested: number | null, opened: number | null): boolean {
  return requested != null && opened != null && Math.abs(requested - opened) > 1;
}

function formatRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'auto';
  if (value === 44100) return '44.1 kHz';
  if (value === 48000) return '48 kHz';
  return `${value} Hz`;
}

function formatMs(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
}
