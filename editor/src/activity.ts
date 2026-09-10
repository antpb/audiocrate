export interface JackActivity {
  peak: number;
  rms: number;
  bipolar: number;
  mean: number;
  pulse: boolean;
  wave: Float32Array;
}

export interface NodeActivity {
  outputs: Record<string, JackActivity>;
  inputs: Record<string, JackActivity>;
}

const emptyWave = new Float32Array(32);

export function silentJack(): JackActivity {
  return { peak: 0, rms: 0, bipolar: 0, mean: 0, pulse: false, wave: emptyWave };
}

export function jackFromOutputs(outputs: Record<string, JackActivity> | undefined, name: string): JackActivity {
  if (!outputs) return silentJack();
  return outputs[name] ?? (name === 'cv' ? outputs.audio : name === 'audio' ? outputs.cv : undefined) ?? silentJack();
}

export function loudestJack(activity: NodeActivity | undefined): JackActivity | undefined {
  if (!activity) return undefined;
  let best: JackActivity | undefined;
  for (const jack of [...Object.values(activity.outputs), ...Object.values(activity.inputs)]) {
    if (!best || jack.peak > best.peak) best = jack;
  }
  return best;
}

type Listener = () => void;

class ActivityBus {
  private readonly frames = new Map<string, NodeActivity>();
  private readonly listeners = new Set<Listener>();
  private version = 0;

  get(id: string): NodeActivity | undefined {
    return this.frames.get(id);
  }

  jack(id: string, side: 'outputs' | 'inputs', key: string): JackActivity {
    return this.frames.get(id)?.[side][key] ?? silentJack();
  }

  set(id: string, activity: NodeActivity): void {
    this.frames.set(id, activity);
    this.notify();
  }

  /** One store write and one React ping for a whole meter frame. */
  publish(next: Map<string, NodeActivity>, force = false): void {
    let changed = force || this.frames.size !== next.size;
    if (!changed) {
      for (const [id, activity] of next) {
        if (activitySig(this.frames.get(id)) !== activitySig(activity)) {
          changed = true;
          break;
        }
      }
    }
    this.frames.clear();
    for (const [id, activity] of next) this.frames.set(id, activity);
    if (changed) this.notify();
  }

  clear(): void {
    this.frames.clear();
    this.notify();
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion(): number {
    return this.version;
  }
}

export const activityBus = new ActivityBus();

export function activitySig(activity: NodeActivity | undefined): number {
  if (!activity) return 0;
  let sig = 0;
  for (const jack of Object.values(activity.outputs)) sig += jackSig(jack);
  for (const jack of Object.values(activity.inputs)) sig += jackSig(jack) * 17;
  return sig;
}

function jackSig(jack: JackActivity): number {
  return Math.round(jack.peak * 24) + (jack.pulse ? 48 : 0);
}

/** Instant attack, exponential fall. Stops a 5ms analyser window from flashing a cable on then off. */
export function holdPeak(previous: number, instant: number, dtSec: number, decaySec = 0.22): number {
  const decayed = previous * Math.exp(-Math.max(0, dtSec) / Math.max(0.04, decaySec));
  return Math.max(instant, decayed);
}

/** Peak that lights a cable. Slow polling stays below this until something is actually audible. */
export const METER_WAKE_PEAK = 0.04;
/** Drop below this before a fast meter may go to sleep. */
export const METER_SLEEP_PEAK = 0.015;
/** Stay fast this long after the last audible peak, then poll slowly. */
export const METER_SLEEP_AFTER_MS = 400;
/** Quiet-graph analyser poll. */
export const METER_SLOW_MS = 250;

export function meterRefresh(state: {
  fast: boolean;
  peak: number;
  quietMs: number;
  dtMs: number;
}): { fast: boolean; quietMs: number } {
  if (state.peak >= METER_WAKE_PEAK) return { fast: true, quietMs: 0 };
  if (state.peak >= METER_SLEEP_PEAK) return { fast: state.fast, quietMs: 0 };
  const quietMs = state.quietMs + Math.max(0, state.dtMs);
  if (state.fast && quietMs < METER_SLEEP_AFTER_MS) return { fast: true, quietMs };
  return { fast: false, quietMs };
}

export function readAnalyser(analyser: AnalyserNode, buffer: Float32Array, wave?: Float32Array): JackActivity {
  analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
  let peak = 0;
  let sum = 0;
  let meanSum = 0;
  let last = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i] ?? 0;
    const abs = sample < 0 ? -sample : sample;
    if (abs > peak) peak = abs;
    sum += sample * sample;
    meanSum += sample;
    last = sample;
  }
  const drawn = wave ?? new Float32Array(32);
  const step = Math.max(1, Math.floor(buffer.length / 32));
  for (let i = 0; i < 32; i += 1) drawn[i] = buffer[i * step] ?? 0;
  return {
    peak: Math.min(1, peak),
    rms: Math.sqrt(sum / buffer.length),
    bipolar: last,
    mean: meanSum / buffer.length,
    pulse: peak > 0.04,
    wave: drawn.slice(),
  };
}
