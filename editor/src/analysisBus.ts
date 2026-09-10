import {
  centsOffPitch,
  fftMagnitude,
  frequencyToMidi,
  momentaryLufs,
  noteName,
  yinPitch,
  type AnalysisMessage,
} from '../../src/index';

export interface AnalysisView {
  peak: number;
  rms: number;
  wave: Float32Array;
  spectrum: Float32Array;
  hz: number;
  midi: number;
  note: string;
  cents: number;
  lufs: number;
}

const emptyWave = new Float32Array(0);
const emptySpec = new Float32Array(0);

export const silentAnalysis: AnalysisView = {
  peak: 0,
  rms: 0,
  wave: emptyWave,
  spectrum: emptySpec,
  hz: -1,
  midi: Number.NaN,
  note: '',
  cents: Number.NaN,
  lufs: -70,
};

const SPEC_BARS = 48;

export function deriveAnalysis(frame: AnalysisMessage, sampleRate: number): AnalysisView {
  const meter = frame.meters.meter;
  const capture = frame.captures.scope ?? emptyWave;
  let peak = meter?.peak ?? 0;
  let rms = meter?.rms ?? 0;
  if (!meter && capture.length > 0) {
    let sumSq = 0;
    let max = 0;
    for (let i = 0; i < capture.length; i += 1) {
      const s = capture[i] ?? 0;
      const a = Math.abs(s);
      if (a > max) max = a;
      sumSq += s * s;
    }
    peak = max;
    rms = Math.sqrt(sumSq / capture.length);
  }
  const hz = capture.length >= 64 ? yinPitch(capture, sampleRate) : -1;
  const midi = hz > 0 ? frequencyToMidi(hz) : Number.NaN;
  const cents = hz > 0 ? centsOffPitch(hz) : Number.NaN;
  const spectrum = capture.length >= 64 ? downsampleSpectrum(fftMagnitude(capture), SPEC_BARS) : emptySpec;
  const lufs = capture.length >= 64 ? momentaryLufs(capture, sampleRate) : -70;
  return {
    peak,
    rms,
    wave: capture,
    spectrum,
    hz,
    midi,
    note: Number.isFinite(midi) ? noteName(Math.round(midi)) : '',
    cents,
    lufs,
  };
}

function downsampleSpectrum(bins: Float32Array, bars: number): Float32Array {
  const out = new Float32Array(bars);
  if (bins.length === 0) return out;
  const usable = Math.max(1, Math.floor(bins.length * 0.45));
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor((i / bars) * usable);
    const end = Math.max(start + 1, Math.floor(((i + 1) / bars) * usable));
    let max = 0;
    for (let b = start; b < end && b < bins.length; b += 1) {
      const v = bins[b] ?? 0;
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

type Listener = () => void;

class AnalysisBus {
  private readonly frames = new Map<string, AnalysisView>();
  private readonly listeners = new Set<Listener>();
  private version = 0;

  get(id: string): AnalysisView | undefined {
    return this.frames.get(id);
  }

  set(id: string, view: AnalysisView): void {
    this.frames.set(id, view);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.frames.clear();
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function analysisOutletValue(
  view: AnalysisView | undefined,
  name: string,
  held?: { note: number; hz: number; cents: number },
): number {
  if (!view) return 0;
  const voiced = view.hz > 0 && Number.isFinite(view.midi);
  switch (name) {
    case 'peak':
      return view.peak;
    case 'rms':
      return view.rms;
    case 'lufs':
      return view.lufs;
    case 'hz':
      return voiced ? view.hz : (held?.hz ?? 0);
    case 'note':
      return voiced ? view.midi : (held?.note ?? 0);
    case 'cv': {
      const midi = voiced ? view.midi : (held?.note ?? 69);
      return (midi - 69) / 12;
    }
    case 'cents':
      return voiced && Number.isFinite(view.cents) ? view.cents : (held?.cents ?? 0);
    case 'gate':
      return voiced ? 1 : 0;
    default:
      return 0;
  }
}

export const analysisBus = new AnalysisBus();
