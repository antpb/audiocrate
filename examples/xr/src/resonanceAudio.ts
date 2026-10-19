/**
 * resonance-stage crate audio engine.
 *
 * The concert's stems run as crate voices: one `samplePlay` node per stem,
 * self-looping, wired to a `THREE.PositionalAudio` through the shared
 * `CrateAudio` bridge so the spatial re-mix is identical to the engine's
 * `PositionalAudio` path. There is no `AudioBufferSourceNode` and no
 * `THREE.AudioLoader`; each stem decodes with crate's `decodeWav` into a
 * `SampleBox` and the loop is owned by the `samplePlay` node.
 *
 * The per-stem spectrum the visuals read is crate-native: each graph carries a
 * `tap.capture`, and the main thread runs crate's own `fftMagnitude` over the
 * captured window, dB-mapped to the 0..255 byte range `readAudio` expects.
 * The master is the sum of the stem byte arrays, so the "whole mix" the
 * beat/energy/strobe logic was written against is reproduced with no
 * `AnalyserNode` at all.
 *
 * Transport maps onto the voice's gate and its live `position` param:
 * `samplePlay` (no explicit gate input) takes the gate from the voice, arms
 * `mem.pos` to the current `position` on the gate-on edge, and, while looping,
 * wraps `mem.pos` back to that same `position`. So arming a stem is:
 * `set('position', P)`, `noteOn()`, then flip `position` to 0 one block later,
 * and the stem plays from P to the end and loops the full length. That is the
 * crate-native equivalent of a BufferSource with `offset` + `loop`.
 */
import { ASL, decodeWav, fftMagnitude, samplePlay, tap } from './crate';
import type { SampleBox } from './crate';
import { createCrateAudio, type CrateAudio, type ThreeListenerLike } from './CrateAudio';

/** One decoded stem and its crate voice, plus the smoothed band values readAudio keeps. */
export interface ResonanceStem {
  readonly audio: CrateAudio;
  bytes: Uint8Array;
  lvl: number;
  lo: number;
  hi: number;
  playing: boolean;
  /** The position the stem was last seated at, in ms, or null until armed. */
  seatedPosMs: number | null;
  /** Context time the stem was last seated, for drift checks. */
  seatedAt: number;
}

export interface ResonanceAudio {
  readonly stems: ResonanceStem[];
  readonly durationMs: number;
  /** The whole-mix spectrum as one byte per bin (sum of the stem arrays, clamped). */
  read(): Uint8Array;
  /** Arm + start every loaded stem at `posMs` into the loop (skips already-playing ones). */
  arm(posMs: number): void;
  /** Gate every stem off. The console re-arms from a known position. */
  stop(): void;
  /** One stem's live volume; a muted stem keeps running so unmute stays in sync. */
  setVolume(index: number, value: number): void;
  /** Reposition one playing stem after a large wall-clock drift. */
  align(index: number, posMs: number): void;
  dispose(): void;
}

/**
 * Capture window in samples. `fftMagnitude` yields `window/2` bins, so 512 →
 * 256, matching the original master `AnalyserNode` (`fftSize` 512 → 256 bins
 * over the full range). The stem band math reads the low half, so it is
 * unaffected by the coarser grid the original's 128-sample stem analysers used.
 */
const CAPTURE_WINDOW = 512;
const ANALYSIS_HZ = 20;
/**
 * How long the arm offset is held before the loop base flips to 0. Must exceed
 * one render quantum so the gate-on edge (which arms `mem.pos` to `position`)
 * is consumed before the base moves.
 */
const ARM_HOLD_MS = 24;

/** Map a linear-magnitude spectrum to 0..255 bytes, like `getByteFrequencyData`. */
function toBytes(mag: Float32Array): Uint8Array {
  const n = mag.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = 20 * Math.log10(mag[i] + 1e-4);
    out[i] = v <= -100 ? 0 : v >= 0 ? 255 : ((v + 100) * 2.55) | 0;
  }
  return out;
}

function mixToMono(wav: {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}): SampleBox {
  if (wav.numberOfChannels <= 1) {
    return { samples: wav.getChannelData(0), sampleRate: wav.sampleRate };
  }
  const frames = wav.length;
  const out = new Float32Array(frames);
  for (let c = 0; c < wav.numberOfChannels; c++) {
    const d = wav.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] += d[i] / wav.numberOfChannels;
  }
  return { samples: out, sampleRate: wav.sampleRate };
}

interface DecodedStem {
  box: SampleBox;
}

/**
 * Decode the stems and build one spatial crate voice per available URL.
 *
 * `urls` is the full layer list (nulls = no stem). `three` is the engine's
 * namespace (the plugin has it as `window.THREE`); it is `any` because the
 * plugin is untyped JS and hands its global through. The voices are built but
 * not attached to the scene graph: the caller owns placement and adds each
 * `stem.audio.audio` (a `THREE.PositionalAudio`) where it wants the emitter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createResonanceAudio(
  listener: ThreeListenerLike,
  urls: Array<string | null>,
  three: any,
  volume: number,
  spatial: { refDistance: number; rolloffFactor: number; maxDistance: number },
): Promise<ResonanceAudio> {
  const context = listener.context;
  const armed = urls.filter(Boolean) as string[];

  const decoded = new Map<string, DecodedStem>();
  let durationMs = 0;
  for (const url of armed) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`resonance stem fetch failed (${res.status})`);
    const wav = decodeWav(new Uint8Array(await res.arrayBuffer()));
    const box = mixToMono(wav);
    decoded.set(url, { box });
    const dur = (box.samples.length / box.sampleRate) * 1000;
    if (!durationMs) durationMs = dur;
  }

  const stems: ResonanceStem[] = [];
  const stopAnalysis: Array<() => void> = [];

  await Promise.all(armed.map(async (url, i) => {
    const box = decoded.get(url)!.box;
    // `position` is the only live param: it arms the start offset and doubles
    // as the loop wrap target. `loop: 1` is a constant, not a param.
    const audio = await createCrateAudio(
      listener,
      ASL.node(({ position }) => tap.capture(samplePlay({ box, position, loop: 1 }), { id: 'stem' })),
      {
        params: { position: 0 },
        volume,
        spatial,
      },
      three,
    );
    const stem: ResonanceStem = {
      audio,
      bytes: new Uint8Array(CAPTURE_WINDOW >> 1),
      lvl: 0,
      lo: 0,
      hi: 0,
      playing: false,
      seatedPosMs: null,
      seatedAt: context.currentTime,
    };
    const stop = audio.onAnalysis((frame) => {
      const cap = frame.captures.stem;
      if (cap && cap.length) stem.bytes = toBytes(fftMagnitude(cap));
    }, ANALYSIS_HZ);
    stopAnalysis.push(stop);
    stems[i] = stem;
  }));

  const master = new Uint8Array(256);

  const read = (): Uint8Array => {
    master.fill(0);
    for (const s of stems) {
      const b = s.bytes;
      if (!b.length) continue;
      for (let i = 0; i < 256; i++) master[i] += b[i] ?? 0;
    }
    for (let i = 0; i < 256; i++) master[i] = Math.min(255, master[i]);
    return master;
  };

  /**
   * Seat one stem at `posMs` and let it run. Arms `mem.pos` to that offset on the
   * gate-on edge, then flips the loop base to 0 so the wrap lands on the start:
   * the stem plays pos→end, then the full loop (a BufferSource `offset`+`loop`).
   */
  const startStem = (s: ResonanceStem, posMs: number) => {
    s.audio.set('position', posMs / 1000);
    s.audio.noteOn();
    s.playing = true;
    s.seatedPosMs = posMs;
    s.seatedAt = context.currentTime;
    window.setTimeout(() => s.audio.set('position', 0), ARM_HOLD_MS);
  };

  const arm = (posMs: number) => {
    for (const s of stems) {
      if (s && !s.playing) startStem(s, posMs);
    }
  };

  const stop = () => {
    for (const s of stems) {
      if (!s) continue;
      s.audio.noteOff();
      s.playing = false;
      s.seatedPosMs = null;
    }
  };

  const setVolume = (index: number, value: number) => {
    stems[index]?.audio.setVolume(value);
  };

  /**
   * Where a playing stem is actually at right now, in room-position ms. Its
   * seated position has advanced with the audio clock since `seatedAt`; the
   * room's wall clock and the audio hardware clock are the two that can drift.
   */
  const actualPos = (s: ResonanceStem): number => {
    if (s.seatedPosMs == null || durationMs <= 0) return 0;
    let a = (s.seatedPosMs + (context.currentTime - s.seatedAt) * 1000) % durationMs;
    if (a < 0) a += durationMs;
    return a;
  };

  /**
   * Correct a stem whose audio clock has drifted from the room. A re-seat is a
   * gate off+on, which costs a ~24ms silence, so it only fires past a real
   * drift threshold (matching the original's 350ms) — otherwise the 700ms poll
   * that calls this would make the show chop constantly.
   */
  const align = (index: number, posMs: number) => {
    const s = stems[index];
    if (!s || !s.playing || s.seatedPosMs == null || durationMs <= 0) return;
    const target = posMs % durationMs;
    let drift = Math.abs(actualPos(s) - target);
    drift = Math.min(drift, durationMs - drift);
    if (drift > 350) {
      s.audio.noteOff();
      s.playing = false;
      window.setTimeout(() => startStem(s, posMs), ARM_HOLD_MS);
    }
  };

  const dispose = () => {
    for (const fn of stopAnalysis) {
      try { fn(); } catch { /* already gone */ }
    }
    stopAnalysis.length = 0;
    for (const s of stems) {
      try { s?.audio.dispose(); } catch { /* already gone */ }
    }
    stems.length = 0;
  };

  return { stems, durationMs, read, arm, stop, setVolume, align, dispose };
}
