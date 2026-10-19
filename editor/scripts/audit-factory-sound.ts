/**
 * Listens to every factory patch, as far as numbers can.
 *
 * Renders each one through the same flatten and compile the browser plays
 * (`buildPluginDocument`, then `compileVoice`) and measures what its name
 * promises: a bass's pitch and weight, a pad's attack, a wah's moving
 * filter, a tremolo's rate, a delay's echo times, a reverb's decay, how wide
 * a widener is, and what each costs to run. The numbers are not a verdict.
 * They are what a verdict is made from, so that "does Tape Echo sound like a
 * tape echo" stops being a question somebody has to remember to ask by ear
 * for a hundred patches.
 *
 *   npm run audit:presets            report to stdout
 *   npm run audit:presets -- --json  one JSON object per patch
 */
import { compileVoice, type CompiledVoice } from '../../src/asl/compile';
import type { TransportSnapshot } from '../../src/asl/transportNodes';
import { FACTORY_PATCHES, type FactoryPatch } from '../src/factoryPatches';
import { buildPluginDocument } from '../src/pluginDoc';

const SR = 48000;
const BLOCK = 128;
const BPM = 120;

// MARK: - Rendering

interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

interface Built {
  voice: CompiledVoice;
  defaults: Record<string, number>;
  stereoInput: boolean;
}

function build(entry: FactoryPatch): Built {
  const role = entry.slot === 'instrument' ? 'instrument' : 'insert';
  const doc = buildPluginDocument(entry.patch, entry.name, role);
  const compiled = doc.compiled!;
  const defaults: Record<string, number> = {};
  for (const [name, descriptor] of Object.entries(compiled.params)) defaults[name] = descriptor.default;
  return { voice: compileVoice(compiled.graph as never), defaults, stereoInput: true };
}

function transportAt(frame: number): TransportSnapshot {
  return { beats: (frame * BPM) / (SR * 60), bpm: BPM, playing: true, beatsPerBar: 4, beatUnit: 4 };
}

/**
 * One voice, or a chord of voices summed the way the pool sums them. Notes
 * are `[note, onSec, offSec]`; an insert ignores notes and holds its gate.
 */
function render(
  built: Built,
  seconds: number,
  options: { notes?: [number, number, number][]; input?: Stereo; gateOpen?: boolean } = {},
): Stereo & { cost: number } {
  const frames = Math.round(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const players = (options.notes ?? [[-1, 0, seconds]]).map(([note, on, off], index) => {
    const state = built.voice.createState({ seed: 1 + index });
    for (const [name, value] of Object.entries(built.defaults)) state.params[name] = value;
    return { state, note, on: Math.round(on * SR), off: Math.round(off * SR), started: false, released: false };
  });
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const began = performance.now();
  for (let start = 0; start < frames; start += BLOCK) {
    const n = Math.min(BLOCK, frames - start);
    if (options.input) {
      inL.fill(0);
      inR.fill(0);
      inL.set(options.input.left.subarray(start, start + n));
      inR.set(options.input.right.subarray(start, start + n));
    }
    for (const player of players) {
      if (!player.started && start >= player.on) {
        player.started = true;
        if (player.note >= 0) built.voice.noteOn(player.state, { note: player.note, velocity: 0.8 });
        else if (options.gateOpen !== false) player.state.gate = true;
      }
      if (player.started && !player.released && player.note >= 0 && start >= player.off) {
        player.released = true;
        built.voice.noteOff(player.state);
      }
      if (!player.started) continue;
      outL.fill(0);
      outR.fill(0);
      const stereo = built.voice.renderBlock(player.state, SR, outL, options.input ? inL : undefined, {
        inputR: options.input ? inR : undefined,
        outputR: outR,
        transport: transportAt(start),
      });
      for (let i = 0; i < n; i++) {
        left[start + i] += outL[i]!;
        right[start + i] += stereo ? outR[i]! : outL[i]!;
      }
    }
  }
  const cost = (performance.now() - began) / 1000 / seconds;
  return { left, right, cost };
}

// MARK: - Test signals

function signal(seconds: number, fill: (t: number, i: number) => number): Stereo {
  const frames = Math.round(seconds * SR);
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i++) left[i] = fill(i / SR, i);
  return { left, right: left.slice() };
}

let noiseState = 0x12345678;
function white(): number {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
}

const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** A saw chord, C3 E3 G3, held: the thing a filter, a chorus or a tremolo is put on. */
const chord = () =>
  signal(3, (t) => {
    let v = 0;
    for (const note of [48, 52, 55]) v += 2 * ((t * hz(note)) % 1) - 1;
    return v * 0.15;
  });

/** One click at 0.1 s: the impulse response of a delay or a reverb. */
const impulse = () => signal(4, (_t, i) => (i === Math.round(0.1 * SR) ? 0.8 : 0));

/** A pure 220 Hz sine at -6 dBFS, to see what a drive adds. */
const sine = () => signal(1.5, (t) => 0.5 * Math.sin(2 * Math.PI * 220 * t));

/** Drum-like hits every quarter at 120 bpm over a quiet pad, for dynamics. */
const hits = () => {
  noiseState = 0x12345678;
  return signal(3, (t) => {
    const since = t % 0.5;
    const hit = 0.8 * Math.exp(-since * 30) * white();
    return hit + 0.04 * Math.sin(2 * Math.PI * 110 * t);
  });
};

/** White noise, for a filter's shape. */
const noise = () => {
  noiseState = 0x2468ace1;
  return signal(2, () => 0.25 * white());
};

// MARK: - Measuring

function slice(x: Float32Array, from: number, to: number): Float32Array {
  return x.subarray(Math.max(0, Math.round(from * SR)), Math.min(x.length, Math.round(to * SR)));
}

function peak(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

const db = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -180);

/** RMS in 10 ms hops. */
function envelope(x: Float32Array, hop = 480): number[] {
  const out: number[] = [];
  for (let i = 0; i + hop <= x.length; i += hop) out.push(rms(x.subarray(i, i + hop)));
  return out;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2]!;
        const ai = im[i + k + len / 2]!;
        const xr = ar * wr - ai * wi;
        const xi = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k]! - xr;
        im[i + k + len / 2] = im[i + k]! - xi;
        re[i + k] = re[i + k]! + xr;
        im[i + k] = im[i + k]! + xi;
      }
    }
  }
}

/** Magnitude spectrum of one Hann-windowed frame. */
function spectrum(x: Float32Array, size = 8192): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const n = Math.min(size, x.length);
  for (let i = 0; i < n; i++) re[i] = x[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
  return mag;
}

/** Spectral centroid in Hz, averaged over frames. */
function centroid(x: Float32Array, size = 4096): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i + size <= x.length; i += size) {
    const mag = spectrum(x.subarray(i, i + size), size);
    let num = 0;
    let den = 0;
    for (let k = 1; k < mag.length; k++) {
      num += k * mag[k]!;
      den += mag[k]!;
    }
    if (den > 1e-6) {
      total += (num / den) * (SR / size);
      count++;
    }
  }
  return count ? total / count : 0;
}

/** Centroid per 40 ms frame, for a filter that moves. */
function centroidTrack(x: Float32Array): number[] {
  const size = 2048;
  const hop = 1920;
  const out: number[] = [];
  for (let i = 0; i + size <= x.length; i += hop) {
    const frame = x.subarray(i, i + size);
    if (rms(frame) < 1e-4) continue;
    const mag = spectrum(frame, size);
    let num = 0;
    let den = 0;
    for (let k = 1; k < mag.length; k++) {
      num += k * mag[k]!;
      den += mag[k]!;
    }
    out.push((num / den) * (SR / size));
  }
  return out;
}

/** Fundamental by normalised autocorrelation, 25 Hz to 2 kHz, or 0. */
function pitch(x: Float32Array): number {
  const n = Math.min(x.length, 8192);
  const frame = x.subarray(0, n);
  if (rms(frame) < 1e-4) return 0;
  const minLag = Math.floor(SR / 2000);
  const maxLag = Math.min(Math.floor(SR / 25), n >> 1);
  const r: number[] = [];
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      s += frame[i]! * frame[i + lag]!;
      e1 += frame[i]! * frame[i]!;
      e2 += frame[i + lag]! * frame[i + lag]!;
    }
    const v = s / Math.sqrt(e1 * e2 + 1e-12);
    r.push(v);
    best = Math.max(best, v);
  }
  if (best < 0.5) return 0;
  // The first peak close to the best, so an octave below is not preferred.
  for (let i = 1; i < r.length - 1; i++) {
    if (r[i]! >= 0.9 * best && r[i]! >= r[i - 1]! && r[i]! >= r[i + 1]!) return SR / (i + minLag);
  }
  return 0;
}

/** Strongest periodicity in a 10 ms envelope, 0.3 to 16 Hz, and its depth in dB. */
function modulation(env: number[]): { rate: number; depthDb: number } {
  if (env.length < 64) return { rate: 0, depthDb: 0 };
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  if (mean < 1e-5) return { rate: 0, depthDb: 0 };
  const size = 1 << Math.ceil(Math.log2(env.length * 4));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  env.forEach((v, i) => (re[i] = v - mean));
  fft(re, im);
  const frameRate = 100;
  let best = 0;
  let rate = 0;
  for (let k = 1; k < size / 2; k++) {
    const f = (k * frameRate) / size;
    if (f < 0.3 || f > 16) continue;
    const m = Math.hypot(re[k]!, im[k]!);
    if (m > best) {
      best = m;
      rate = f;
    }
  }
  const sorted = [...env].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)]!;
  const hi = sorted[Math.floor(sorted.length * 0.95)]!;
  return { rate, depthDb: db(hi) - db(Math.max(lo, hi * 1e-3)) };
}

/** Seconds from the first sample to 90% of the envelope's peak. */
function attack(env: number[]): number {
  const top = Math.max(...env);
  const index = env.findIndex((v) => v >= 0.9 * top);
  return index * 0.01;
}

/** Seconds after `from` until the envelope stays 60 dB under its peak. */
function tail(env: number[], from: number): number {
  const top = Math.max(...env);
  let last = Math.round(from * 100);
  for (let i = env.length - 1; i >= 0; i--) {
    if (env[i]! > top * 1e-3) {
      last = i;
      break;
    }
  }
  return Math.max(0, last * 0.01 - from);
}

function correlation(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa * bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 1;
}

/** Echo times in an impulse response: local peaks at least 30 ms apart and within 30 dB of the loudest. */
function echoes(ir: Float32Array): number[] {
  const env = envelope(ir, 96);
  const top = Math.max(...env);
  const out: number[] = [];
  for (let i = 1; i < env.length - 1; i++) {
    const t = (i * 96) / SR - 0.1;
    if (t < 0.02) continue;
    if (env[i]! > top * 0.03 && env[i]! >= env[i - 1]! && env[i]! > env[i + 1]!) {
      if (out.length === 0 || t - out[out.length - 1]! > 0.03) out.push(Number(t.toFixed(3)));
    }
    if (out.length >= 6) break;
  }
  return out;
}

/** RT60 from the Schroeder integral of an impulse response, fitted -5 to -25 dB. */
function rt60(ir: Float32Array): number {
  const energy = new Float64Array(ir.length);
  let sum = 0;
  for (let i = ir.length - 1; i >= 0; i--) {
    sum += ir[i]! * ir[i]!;
    energy[i] = sum;
  }
  if (sum < 1e-12) return 0;
  let t5 = -1;
  let t25 = -1;
  for (let i = 0; i < ir.length; i++) {
    const level = 10 * Math.log10(energy[i]! / sum);
    if (t5 < 0 && level <= -5) t5 = i;
    if (t25 < 0 && level <= -25) {
      t25 = i;
      break;
    }
  }
  if (t5 < 0 || t25 < 0) return ir.length / SR;
  return (3 * (t25 - t5)) / SR;
}

/** Energy in harmonics 2 to 10 against the fundamental, in dB. */
function harmonics(x: Float32Array, f0: number): number {
  const mag = spectrum(x, 16384);
  const bin = (f: number) => Math.round((f * 16384) / SR);
  const at = (f: number) => {
    let m = 0;
    for (let k = bin(f) - 2; k <= bin(f) + 2; k++) m = Math.max(m, mag[k] ?? 0);
    return m;
  };
  const fundamental = at(f0);
  let rest = 0;
  for (let h = 2; h <= 10; h++) rest += at(f0 * h) ** 2;
  return db(Math.sqrt(rest)) - db(fundamental);
}

/** Output over input energy in octave bands, dB, 63 Hz to 16 kHz. */
function bands(input: Float32Array, output: Float32Array): number[] {
  const a = spectrum(input, 16384);
  const b = spectrum(output, 16384);
  const out: number[] = [];
  for (let f = 63; f <= 16000; f *= 2) {
    let ea = 0;
    let eb = 0;
    for (let k = Math.round((f / Math.SQRT2) * 16384 / SR); k < Math.round((f * Math.SQRT2) * 16384 / SR); k++) {
      ea += a[k]! ** 2;
      eb += b[k]! ** 2;
    }
    out.push(Math.round(10 * Math.log10((eb + 1e-18) / (ea + 1e-18))));
  }
  return out;
}

/** Note onsets per second, from rises in a 10 ms envelope. */
function onsets(env: number[]): number {
  const top = Math.max(...env);
  let count = 0;
  let armed = true;
  for (let i = 3; i < env.length; i++) {
    const rise = env[i]! - env[i - 3]!;
    if (armed && rise > top * 0.15) {
      count++;
      armed = false;
    } else if (rise < 0) armed = true;
  }
  return count / (env.length / 100);
}

const r = (v: number, d = 2) => Number(v.toFixed(d));

// MARK: - Per slot

function instrument(built: Built) {
  const low = render(built, 2.2, { notes: [[48, 0, 1.2]] });
  const mid = render(built, 2.2, { notes: [[60, 0, 1.2]] });
  const four = render(built, 2.2, { notes: [[60, 0, 1.2], [64, 0, 1.2], [67, 0, 1.2], [71, 0, 1.2]] });
  const env = envelope(mid.left);
  const held = slice(mid.left, 0.35, 1.15);
  const measuredLow = pitch(slice(low.left, 0.35, 1.15));
  const measuredMid = pitch(held);
  const decayed = env.length > 110 ? db(env[110]! / Math.max(...env.slice(0, 40))) : 0;
  return {
    peak: r(peak(mid.left), 3),
    chordPeak: r(peak(four.left), 3),
    heldRmsDb: r(db(rms(held)), 1),
    attackSec: r(attack(env.slice(0, 120)), 3),
    sustainDb: r(decayed, 1),
    releaseSec: r(tail(env, 1.2), 2),
    pitchC3: r(measuredLow, 1),
    pitchC4: r(measuredMid, 1),
    semitonesFromC4: measuredMid > 0 ? r(12 * Math.log2(measuredMid / hz(60)), 1) : null,
    centroidHz: Math.round(centroid(held)),
    movement: modulation(envelope(held)),
    brightnessSwingHz: (() => {
      const track = centroidTrack(held);
      return track.length ? Math.round(Math.max(...track) - Math.min(...track)) : 0;
    })(),
    width: r(1 - correlation(mid.left, mid.right), 3),
    cost: r(mid.cost, 4),
    chordCost: r(four.cost, 4),
  };
}

function effect(built: Built) {
  const dryChord = chord();
  const wetChord = render(built, 3, { input: dryChord });
  const ir = render(built, 4, { input: impulse() });
  const dryHits = hits();
  const wetHits = render(built, 3, { input: dryHits });
  const drySine = sine();
  const wetSine = render(built, 1.5, { input: drySine });
  const dryNoise = noise();
  const wetNoise = render(built, 2, { input: dryNoise });
  const silence = render(built, 1, { input: signal(1, () => 0) });
  const held = slice(wetChord.left, 0.5, 2.9);
  const irL = slice(ir.left, 0.1, 4);
  const track = centroidTrack(held);
  const crest = (x: Float32Array) => db(peak(x) / Math.max(1e-9, rms(x)));
  return {
    gainDb: r(db(rms(held)) - db(rms(slice(dryChord.left, 0.5, 2.9))), 1),
    peakChord: r(peak(wetChord.left), 3),
    peakHits: r(peak(wetHits.left), 3),
    dcOnSilence: r(Math.abs(slice(silence.left, 0.5, 1).reduce((a, b) => a + b, 0) / (0.5 * SR)), 4),
    centroidHz: Math.round(centroid(held)),
    dryCentroidHz: Math.round(centroid(slice(dryChord.left, 0.5, 2.9))),
    brightnessSwingHz: track.length ? Math.round(Math.max(...track) - Math.min(...track)) : 0,
    movement: modulation(envelope(held)),
    echoesSec: echoes(ir.left),
    rt60Sec: r(rt60(irL), 2),
    irTailSec: r(tail(envelope(ir.left), 0.1), 2),
    harmonicsDb: r(harmonics(slice(wetSine.left, 0.3, 1.4), 220), 1),
    crestChangeDb: r(crest(slice(wetHits.left, 0.2, 3)) - crest(slice(dryHits.left, 0.2, 3)), 1),
    hitTailSec: r(tail(envelope(slice(wetHits.left, 0.5, 0.99)), 0), 2),
    bandsDb: bands(slice(dryNoise.left, 0.2, 2), slice(wetNoise.left, 0.2, 2)),
    width: r(1 - correlation(wetChord.left, wetChord.right), 3),
    cost: r(wetChord.cost, 4),
  };
}

function selfPlaying(built: Built) {
  const out = render(built, 8);
  const env = envelope(out.left);
  const pitches = new Set<number>();
  for (let t = 0; t + 0.25 <= 8; t += 0.25) {
    const f = pitch(slice(out.left, t, t + 0.2));
    if (f > 0) pitches.add(Math.round(12 * Math.log2(f / 440) + 69));
  }
  const silentFrames = env.filter((v) => v < 1e-3).length / Math.max(1, env.length);
  return {
    peak: r(peak(out.left), 3),
    rmsDb: r(db(rms(out.left)), 1),
    onsetsPerSec: r(onsets(env), 2),
    notes: [...pitches].sort((a, b) => a - b),
    centroidHz: Math.round(centroid(out.left)),
    movement: modulation(env),
    silentFraction: r(silentFrames, 2),
    width: r(1 - correlation(out.left, out.right), 3),
    cost: r(out.cost, 4),
  };
}

// MARK: - Report

const json = process.argv.includes('--json');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7).split(',');
for (const entry of FACTORY_PATCHES) {
  if (only && !only.includes(entry.id)) continue;
  let measured: unknown;
  try {
    const built = build(entry);
    measured =
      entry.slot === 'instrument' ? instrument(built) : entry.slot === 'effect' ? effect(built) : selfPlaying(built);
  } catch (err) {
    measured = { error: err instanceof Error ? err.message : String(err) };
  }
  const kinds = entry.patch.nodes
    .map((node) => node.kind)
    .filter((kind) => !['keyboard', 'line', 'master', 'transport', 'gain', 'offset', 'limiter', 'control'].includes(kind));
  const line = { id: entry.id, category: entry.category, name: entry.name, blurb: entry.blurb, kinds, ...(measured as object) };
  console.log(json ? JSON.stringify(line) : `${entry.category} / ${entry.name}\n  ${entry.blurb}\n  ${kinds.join(' ')}\n  ${JSON.stringify(measured)}\n`);
}
