import {
  LOOPER_LENGTH_PRESETS,
  TIME_SIG_PRESETS,
  denormalizeParam,
  describeAudioMaterial,
  isTransportKind,
  noteName,
  type AudioMaterial,
} from '../../src/index';
import { AnalysisView } from './AnalysisView';
import { isAnalysisKind } from './analysisKinds';
import { isKeyboardKind, stealLabel, type AnalogSnapshot } from './analogKeyboard';
import { isLineKind, isMasterKind, isMidiClipKind, isMidiIoKind } from './tools';
import { MidiClipInspector } from './MidiClipInspector';
import { MidiIoInspector } from './MidiIoInspector';
import { cvInputs } from './controlInputs';
import { RangeSlider } from './RangeSlider';
import { useAnalysis } from './useAnalysis';
import { VoiceStrip } from './VoiceStrip';
import { AssetSlot } from './AssetSlot';
import { LineDeviceSelect } from './LineDeviceSelect';
import { lineMonitorOn } from './lineInput';
import { hasFileSlots } from './nodeAssets';
import { WavePicker } from './WavePicker';
import { OSC_WAVE_HINTS, shapeLabelForWave } from './oscillatorWaves';
import { NoisePicker } from './NoisePicker';
import { NOISE_COLOR_HINTS } from './noiseColors';
import { ParametricEqPanel } from './ParametricEqPanel';
import { DrumPadPanel } from './DrumPadPanel';
import { SpatialLookPanel } from './SpatialLookPanel';
import { ControlGroups } from './ControlGroups';
import { WAVESHAPE_HINTS } from './waveshapeCurves';

interface InspectorPanelProps {
  material: AudioMaterial | null;
  kind: string | null;
  snapshot: AnalogSnapshot;
  masterMonitor: boolean;
  lineDeviceId: string | null;
  lineOpenedLabel?: string | null;
  lineOpenError?: string | null;
  onMasterMonitor: (on: boolean) => void;
  onLineDevice: (id: string | null) => Promise<void>;
  onParam: (name: string, value: number) => void;
  onRemove: () => void;
  nodeId?: string | null;
  namFilename?: string | null;
  namFilenameR?: string | null;
  irFilename?: string | null;
  sampleFilename?: string | null;
  wavetableFilename?: string | null;
  onNamFile?: (file: File) => Promise<void>;
  onNamFactory?: () => Promise<void>;
  onNamClear?: () => void;
  onNamRFile?: (file: File) => Promise<void>;
  onNamRClear?: () => void;
  onIrFile?: (file: File) => Promise<void>;
  onIrClear?: () => void;
  onSampleFile?: (file: File) => Promise<void>;
  onSampleClear?: () => void;
  onWavetableFile?: (file: File) => Promise<void>;
  onWavetableClear?: () => void;
  /** Sixteen slots rather than one, indexed by pad. */
  drumPadFilenames?: readonly (string | null)[];
  onDrumPadFile?: (pad: number, file: File) => Promise<void>;
  onDrumPadClear?: (pad: number) => void;
  onNotePress?: (note: number) => void;
  onNoteRelease?: (note: number) => void;
  nodeData?: Record<string, unknown>;
  onNodeData?: (patch: Record<string, unknown>) => void;
}

export function InspectorPanel({
  material,
  kind,
  snapshot,
  masterMonitor,
  lineDeviceId,
  lineOpenedLabel,
  lineOpenError,
  onMasterMonitor,
  onLineDevice,
  onParam,
  onRemove,
  nodeId,
  namFilename,
  namFilenameR,
  irFilename,
  sampleFilename,
  wavetableFilename,
  onNamFile,
  onNamFactory,
  onNamClear,
  onNamRFile,
  onNamRClear,
  onIrFile,
  onIrClear,
  onSampleFile,
  onSampleClear,
  onWavetableFile,
  onWavetableClear,
  drumPadFilenames,
  onDrumPadFile,
  onDrumPadClear,
  onNotePress,
  onNoteRelease,
  nodeData,
  onNodeData,
}: InspectorPanelProps) {
  const analysis = useAnalysis(nodeId ?? null);
  if (kind && isMasterKind(kind)) {
    return (
      <aside className="inspector">
        <header>
          <h2>Master</h2>
          <span className="kind">output</span>
          <button type="button" className="danger" onClick={onRemove}>
            Remove
          </button>
        </header>
        <p className="hint">
          Cables into in sum. A node that is not patched here is silent, even if you play notes into it.
        </p>
        <label className="param row">
          <span>Monitor</span>
          <input
            type="checkbox"
            checked={masterMonitor}
            onChange={(event) => onMasterMonitor(event.target.checked)}
          />
        </label>
        <p className="hint">Off mutes the speakers. The graph and meters keep running.</p>
      </aside>
    );
  }
  if (kind && isLineKind(kind)) {
    return (
      <aside className="inspector">
        <header>
          <h2>Line / Mic</h2>
          <span className="kind">input</span>
          <button type="button" className="danger" onClick={onRemove}>
            Remove
          </button>
        </header>
        <p className="hint">
          Play captures this input. Patch it into a filter, a meter, or Master. Grant mic permission to see
          device names. The device is this machine&apos;s and is not sent to a session.
        </p>
        <LineDeviceSelect
          deviceId={lineDeviceId}
          openedLabel={lineOpenedLabel ?? null}
          hostError={lineOpenError ?? null}
          onChange={onLineDevice}
        />
        <label className="param row">
          <span>Monitor</span>
          <input
            type="checkbox"
            checked={lineMonitorOn(nodeData)}
            onChange={(event) => onNodeData?.({ monitor: event.target.checked ? 1 : 0 })}
          />
        </label>
        <p className="hint">Off until you turn it on. On sends the live input down the cables. Off keeps it armed but silent.</p>
      </aside>
    );
  }
  if (kind && isMidiClipKind(kind)) {
    return (
      <MidiClipInspector
        data={nodeData}
        onChange={(patch) => onNodeData?.(patch)}
        onRemove={onRemove}
      />
    );
  }
  if (kind && isMidiIoKind(kind)) {
    return (
      <MidiIoInspector
        kind={kind}
        data={nodeData}
        onChange={(patch) => onNodeData?.(patch)}
        onRemove={onRemove}
      />
    );
  }
  if (kind && isKeyboardKind(kind)) {
    return (
      <aside className="inspector">
        <header>
          <h2>Keyboard</h2>
          <span className="kind">{snapshot.polyphony > 1 ? `poly ${snapshot.polyphony}` : 'mono'}</span>
          <button type="button" className="danger" onClick={onRemove}>
            Remove
          </button>
        </header>
        <p className="hint">
          Analog jacks (cv, gate, trig, velocity) are last-note, one CV and one gate. note/gate cables into a
          AudioMaterial allocate voices: one slot per held key, up to that AudioMaterial&apos;s polyphony, stealing{' '}
          {snapshot.steal}.
        </p>
        <VoiceStrip snapshot={snapshot} />
        <p className="key-live">
          last {noteName(snapshot.note)} · {snapshot.cv.toFixed(2)} V · gate {snapshot.gate ? 'high' : 'low'} · vel{' '}
          {snapshot.velocity.toFixed(2)}
        </p>
      </aside>
    );
  }
  if (!material) {
    return (
      <aside className="inspector empty">
        <h2>Inspector</h2>
        <p>Select a node.</p>
      </aside>
    );
  }
  const model = describeAudioMaterial(material);
  const analysisKind = kind != null && isAnalysisKind(kind);
  return (
    <aside className="inspector">
      <header>
        <h2>{model.name}</h2>
        <span className="kind">
          {model.kind}
          {material.polyphony > 1
            ? ` · ${material.polyphony} voices · ${stealLabel(material.voiceStealing)}`
            : ' · mono'}
        </span>
        <button type="button" className="danger" onClick={onRemove}>
          Remove
        </button>
      </header>
      {hasFileSlots(kind) ? (
        <div className="asset-slots">
          {kind === 'amp' && onNamFile && onNamClear ? (
            <AssetSlot
              label="Profile"
              filename={namFilename ?? null}
              accept=".nam,application/json,.json"
              factoryLabel="Factory"
              onChoose={onNamFile}
              onFactory={onNamFactory}
              onClear={onNamClear}
            />
          ) : null}
          {kind === 'amp' && onNamRFile && onNamRClear && (material.getParam('stereoMode') >= 0.5 || namFilenameR) ? (
            <AssetSlot
              label="Profile R"
              filename={namFilenameR ?? null}
              accept=".nam,application/json,.json"
              onChoose={onNamRFile}
              onClear={onNamRClear}
            />
          ) : null}
          {kind === 'ir' && onIrFile && onIrClear ? (
            <AssetSlot
              label="Impulse"
              filename={irFilename ?? null}
              accept="audio/*,.wav,.caf,.aif,.aiff,.flac"
              onChoose={onIrFile}
              onClear={onIrClear}
            />
          ) : null}
          {kind === 'sampleplayer' && onSampleFile && onSampleClear ? (
            <AssetSlot
              label="Sample"
              filename={sampleFilename ?? null}
              accept="audio/*,.wav,.caf,.aif,.aiff,.flac,.mp3,.m4a,.ogg"
              onChoose={onSampleFile}
              onClear={onSampleClear}
            />
          ) : null}
          {kind === 'wavetable' && onWavetableFile && onWavetableClear ? (
            <AssetSlot
              label="Table"
              filename={wavetableFilename ?? null}
              accept="audio/*,.wav,.caf,.aif,.aiff,.flac,.mp3,.m4a,.ogg"
              onChoose={onWavetableFile}
              onClear={onWavetableClear}
            />
          ) : null}
          <p className="hint">
            {kind === 'amp'
              ? material.getParam('stereoMode') >= 0.5
                ? 'Stereo Amp runs two neural models, one per output. Profile R is the right-channel hardware model when NAM Link is off.'
                : 'A .nam profile is the neural amp. No profile is the analog path. Put a cabinet on an IR node after Amp.'
              : kind === 'sampleplayer'
                ? 'Choose a wav, aiff, flac, or mp3. A gate or clock into input fires it. Silent until a file is loaded.'
                : kind === 'wavetable'
                  ? '512 samples or more become 256-sample frames. Shorter files are one cycle. Clear restores the factory bank.'
                  : 'Needs an impulse file. Mix and gain still apply without one, as dry gain.'}
          </p>
        </div>
      ) : null}
      {analysisKind ? <AnalysisView kind={kind ?? ''} view={analysis} /> : null}
      {analysisKind ? (
        <p className="hint">
          Reads the incoming cable. Does not need to reach Master. Note is MIDI, cv is 1V/oct like
          the keyboard, hz / cents / gate follow the lock. Peak, RMS, and LUFS are the same
          numbers as the readout. Cable those into a voice to follow live playing.
        </p>
      ) : null}
      {kind === 'looper' ? (
        <p className="hint">
          Record holds a take. Play starts the loop, restarts from the top, or closes a take that is still
          recording. Bars 0 is free until you close or the ring fills. 2 / 4 / 8 (or any count to 16)
          auto-closes after that many measures, same as the iOS LENGTH row. Threshold 0 is off. Above 0,
          Record arms and capture starts on the first peak at or above that level. Quantize snaps a free
          take to the beat or bar. Start pulses on the first play sample after a take closes and on every
          wrap. End pulses on the last sample of the loop. Cable those into clocks, envelopes, or
          sequencers. Mix at 0 is dry.
        </p>
      ) : null}
      {kind && isTransportKind(kind) ? (
        <>
          <p className="hint">
            This is the session clock. Synced Clock, Synced Delay, and Looper read it without a cable.
            Clock is still free-running Hz. Homecrate already has a session tempo, so this node is how
            the patcher sets one from scratch.
          </p>
          <div className="sig-presets">
            {TIME_SIG_PRESETS.map((preset) => {
              const on =
                material.getParam('beatsPerBar') === preset.beatsPerBar &&
                material.getParam('beatUnit') === preset.beatUnit;
              return (
                <button
                  key={preset.label}
                  type="button"
                  className={on ? 'on' : ''}
                  onClick={() => {
                    onParam('beatsPerBar', preset.beatsPerBar);
                    onParam('beatUnit', preset.beatUnit);
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      {material.polyphony > 1 ? (
        <p className="hint">
          Note and gate from the Keyboard allocate up to {material.polyphony} voices (
          {stealLabel(material.voiceStealing)} steal). Analog cv/gate stay last-note.
        </p>
      ) : null}
      {cvInputs(material).length > 0 ? (
        <p className="hint">
          A cable into a param jack is CV, not audio mix. Unipolar sources (ADSR, clocks) map 0..1 across the
          param range. Bipolar sources (LFO) map -1..1 across that same range.
        </p>
      ) : null}
      {model.auxInputs.length > 0 ? (
        <p className="hint">Aux in: {model.auxInputs.join(', ')}</p>
      ) : null}
      {kind === 'oscillator' ? (
        <p className="hint">
          Eight waves. Shape is pulse width, morph, sync ratio, or harmonic tilt, depending on the wave.
        </p>
      ) : null}
      {kind === 'lfo' ? (
        <p className="hint">
          Same eight waves as the oscillator, at control rate. Shape only appears for Pulse, VarShape,
          SuperSquare, and Harmonic.
        </p>
      ) : null}
      {kind === 'noise' ? (
        <p className="hint">
          White is flat, pink is 1/f, brown is rumble, blue and violet are brighter, grey sits in the mids.
          Cutoff is a lowpass after the generator.
        </p>
      ) : null}
      {kind === 'ParametricEQ' ? (
        <ParametricEqPanel controls={model.controls} onParam={onParam} />
      ) : null}
      {kind === 'drum' ? (
        <DrumPadPanel
          controls={model.controls}
          onParam={onParam}
          padFilenames={drumPadFilenames ?? []}
          {...(onDrumPadFile ? { onPadFile: onDrumPadFile } : {})}
          {...(onDrumPadClear ? { onPadClear: onDrumPadClear } : {})}
          {...(onNotePress ? { onPadTrigger: onNotePress } : {})}
          {...(onNoteRelease ? { onPadRelease: onNoteRelease } : {})}
        />
      ) : null}
      {kind === 'spatialmaster' && material ? (
        <SpatialLookPanel
          yaw={material.getParam('yaw')}
          pitch={material.getParam('pitch')}
          onParam={onParam}
        />
      ) : null}
      {kind === 'spatialsource' ? (
        <p className="hint">
          Metres, with -z ahead of you. x, y and z are CV jacks: patch an LFO into x and the source
          sweeps past you, sample accurately. Global makes it omnidirectional and immune to head
          rotation. This outlet only connects to a Spatial Master.
        </p>
      ) : null}
      {kind === 'SynthVoice' ? (
        <ControlGroups
          groups={[
            { title: 'Oscillator', names: ['type', 'width', 'octave', 'detune', 'unison', 'gain'] },
            { title: 'Filter', names: ['cutoff', 'resonance', 'envAmt'] },
            { title: 'Envelope', names: ['attack', 'decay', 'sustain', 'release'] },
          ]}
          controls={model.controls}
          onParam={onParam}
          hint="Subtractive voice: wave plus a detuned twin, a lowpass, and an amp envelope that can also open the filter."
          renderControl={(control) => {
            if (control.name === 'type' && control.options) {
              const shape = material.getParam('width');
              return (
                <div className="param">
                  <span>
                    {control.label}
                    <em>{control.options[Math.round(control.value)] ?? control.display}</em>
                  </span>
                  <WavePicker
                    options={control.options}
                    value={control.value}
                    shape={shape}
                    onChange={(index) => onParam(control.name, index)}
                  />
                  <p className="hint">{OSC_WAVE_HINTS[Math.round(control.value)] ?? ''}</p>
                </div>
              );
            }
            if (control.name === 'width') {
              const wave = Math.round(material.getParam('type'));
              const label = shapeLabelForWave(wave);
              if (!label) return null;
              return (
                <label className="param">
                  <span>
                    {label}
                    <em>{control.display}</em>
                  </span>
                  <RangeSlider
                    min={0}
                    max={1}
                    step={0.001}
                    value={control.normalized}
                    onChange={(event) =>
                      onParam(control.name, denormalizeParam(control.descriptor, Number(event.target.value)))
                    }
                  />
                </label>
              );
            }
            return undefined;
          }}
        />
      ) : null}
      {kind === 'wavetable' ? (
        <ControlGroups
          groups={[
            { title: 'Table', names: ['position'] },
            { title: 'Pitch', names: ['octave', 'detune', 'gain'] },
            { title: 'Envelope', names: ['attack', 'decay', 'sustain', 'release'] },
          ]}
          controls={model.controls}
          onParam={onParam}
          hint="Position scans the factory frames, or a loaded table of 256-sample frames."
        />
      ) : null}
      {kind === 'breakpoints' ? (
        <ControlGroups
          groups={[
            { title: 'Times', names: ['time0', 'time1', 'time2', 'time3'] },
            { title: 'Levels', names: ['level0', 'level1', 'level2', 'level3'] },
          ]}
          controls={model.controls}
          onParam={onParam}
          hint="Four points from a gate. Times are seconds from the rising edge. Later times that sit before an earlier one clamp forward."
        />
      ) : null}
      {kind === 'waveshape' ? (
        <ControlGroups
          groups={[{ title: 'Shaper', names: ['curve', 'drive', 'mix'] }]}
          controls={model.controls}
          onParam={onParam}
          hint="Drive into a transfer curve, then mix with dry. Mix at 0 is bypass."
          renderControl={(control) => {
            if (control.name === 'curve' && control.options) {
              return (
                <div className="param">
                  <span>
                    {control.label}
                    <em>{control.options[Math.round(control.value)] ?? control.display}</em>
                  </span>
                  <select
                    value={Math.round(control.value)}
                    onChange={(event) => onParam(control.name, Number(event.target.value))}
                  >
                    {control.options.map((option, index) => (
                      <option key={option} value={index}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <p className="hint">{WAVESHAPE_HINTS[Math.round(control.value)] ?? ''}</p>
                </div>
              );
            }
            return undefined;
          }}
        />
      ) : null}
      {kind === 'ParametricEQ' ||
      kind === 'SynthVoice' ||
      kind === 'wavetable' ||
      kind === 'waveshape' ||
      kind === 'breakpoints' ||
      // 246 parameters, all of them already on the pad panel above.
      kind === 'drum'
        ? null
        : model.controls.map((control) => {
        if (kind === 'noise' && control.name === 'color' && control.options) {
          return (
            <div key={control.name} className="param">
              <span>
                {control.label}
                <em>{control.options[Math.round(control.value)] ?? control.display}</em>
              </span>
              <NoisePicker
                options={control.options}
                value={control.value}
                onChange={(index) => onParam(control.name, index)}
              />
              <p className="hint">{NOISE_COLOR_HINTS[Math.round(control.value)] ?? ''}</p>
            </div>
          );
        }
        if ((kind === 'oscillator' || kind === 'lfo') && control.name === 'type' && control.options) {
          const shape = material.getParam('width');
          return (
            <div key={control.name} className="param">
              <span>
                {control.label}
                <em>{control.options[Math.round(control.value)] ?? control.display}</em>
              </span>
              <WavePicker
                options={control.options}
                value={control.value}
                shape={shape}
                onChange={(index) => onParam(control.name, index)}
              />
              <p className="hint">{OSC_WAVE_HINTS[Math.round(control.value)] ?? ''}</p>
            </div>
          );
        }
        if ((kind === 'oscillator' || kind === 'lfo') && control.name === 'width') {
          const wave = Math.round(material.getParam('type'));
          const label = shapeLabelForWave(wave);
          if (!label) return null;
          return (
            <label key={control.name} className="param">
              <span>
                {label}
                <em>{control.display}</em>
              </span>
              <RangeSlider
                min={0}
                max={1}
                step={0.001}
                value={control.normalized}
                onChange={(event) =>
                  onParam(control.name, denormalizeParam(control.descriptor, Number(event.target.value)))
                }
              />
            </label>
          );
        }
        if (control.kind === 'menu' && control.options) {
          return (
            <label key={control.name} className="param">
              <span>{control.label}</span>
              <select
                value={Math.round(control.value)}
                onChange={(event) => onParam(control.name, Number(event.target.value))}
              >
                {control.options.map((option, index) => (
                  <option key={option} value={index}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        if (control.kind === 'switch' && control.name === 'record') {
          const recording = control.value >= 0.5;
          const waiting = recording && material.getParam('threshold') > 0;
          return (
            <div key={control.name} className="looper-rec">
              <button
                type="button"
                className={recording ? 'rec' : ''}
                onClick={() => onParam(control.name, recording ? 0 : 1)}
              >
                {waiting ? 'Armed' : recording ? 'Recording' : 'Record'}
              </button>
              <span>
                {waiting
                  ? 'waiting for a peak at or above threshold'
                  : recording
                    ? 'writing the loop'
                    : 'hold to capture'}
              </span>
            </div>
          );
        }
        if (control.kind === 'switch' && control.name === 'play') {
          const on = control.value >= 0.5;
          return (
            <div key={control.name} className="looper-rec">
              <button
                type="button"
                className={on ? 'on' : ''}
                onClick={() => onParam(control.name, on ? 0 : 1)}
              >
                {on ? 'Playing' : 'Play'}
              </button>
              <span>{on ? 'loop is audible' : 'stopped. press to play from the start'}</span>
            </div>
          );
        }
        if (kind === 'looper' && control.name === 'length') {
          const bars = Math.round(control.value);
          return (
            <div key={control.name} className="param">
              <span>
                {control.label}
                <em>{bars === 0 ? 'Free' : `${bars} bars`}</em>
              </span>
              <div className="sig-presets">
                {LOOPER_LENGTH_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={bars === preset ? 'on' : ''}
                    onClick={() => onParam(control.name, preset)}
                  >
                    {preset === 0 ? 'Free' : String(preset)}
                  </button>
                ))}
              </div>
              <RangeSlider
                min={0}
                max={1}
                step={1 / 16}
                value={control.normalized}
                onChange={(event) =>
                  onParam(control.name, denormalizeParam(control.descriptor, Number(event.target.value)))
                }
              />
            </div>
          );
        }
        if (control.kind === 'switch' && control.name === 'overdub') {
          const overdubbing = control.value >= 0.5;
          return (
            <div key={control.name} className="looper-rec">
              <button
                type="button"
                className={overdubbing ? 'rec' : ''}
                onClick={() => onParam(control.name, overdubbing ? 0 : 1)}
              >
                {overdubbing ? 'Overdubbing' : 'Overdub'}
              </button>
              <span>{overdubbing ? 'summing into the loop' : 'one-deep layer'}</span>
            </div>
          );
        }
        if (control.kind === 'switch' && control.name === 'undo') {
          return (
            <div key={control.name} className="looper-rec">
              <button
                type="button"
                onClick={() => {
                  onParam(control.name, 0);
                  onParam(control.name, 1);
                  window.setTimeout(() => onParam(control.name, 0), 80);
                }}
              >
                Undo
              </button>
              <span>restore the last layer</span>
            </div>
          );
        }
        if (control.kind === 'switch' && control.name === 'clear') {
          return (
            <div key={control.name} className="looper-rec">
              <button
                type="button"
                onClick={() => {
                  onParam(control.name, 0);
                  onParam(control.name, 1);
                  window.setTimeout(() => onParam(control.name, 0), 80);
                }}
              >
                Clear
              </button>
              <span>wipe the recorded buffer</span>
            </div>
          );
        }
        if (control.kind === 'switch') {
          return (
            <label key={control.name} className="param row">
              <span>{control.label}</span>
              <input
                type="checkbox"
                checked={control.value >= 0.5}
                onChange={(event) => onParam(control.name, event.target.checked ? 1 : 0)}
              />
            </label>
          );
        }
        return (
          <label key={control.name} className="param">
            <span>
              {control.label}
              <em>{control.display}</em>
            </span>
            <RangeSlider
              min={0}
              max={1}
              step={0.001}
              value={control.normalized}
              onChange={(event) =>
                onParam(control.name, denormalizeParam(control.descriptor, Number(event.target.value)))
              }
            />
          </label>
        );
      })}
    </aside>
  );
}
