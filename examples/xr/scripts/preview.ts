/**
 * Renders a hillside of stones to a WAV, so the sound can be judged by ear
 * rather than by assertion.
 *
 * Offline, in Node, with no browser and no AudioContext: the same graph the
 * worklet runs, through the same interpreter. That is the property the whole
 * plugin rests on, and it is also just the fastest way to iterate on DSP.
 *
 *   npx esbuild scripts/preview.ts --bundle --format=esm --platform=node \
 *     --outfile=/tmp/preview.mjs && node /tmp/preview.mjs out.wav
 */
import { writeFileSync } from 'node:fs';
import { AutomationLane, OfflineRenderer, Time } from '../src/crate';
import { resonantStoneMaterial } from '../src/materials/resonantStone';

const SR = 48000;
const DURATION = 14;

/** A pentatonic minor scale, the reason a random hillside is still in key. */
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 146.83; // D3

/** Stand-in for `spawn.rng`: deterministic, so this preview is reproducible. */
function alea(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Stone {
  params: Record<string, number>;
  /** Where it sits in the stereo field, as a crude stand-in for the panner. */
  pan: number;
  /** How loud, standing in for distance attenuation. */
  gain: number;
  strikeAt: number | null;
}

const rng = alea(20260907);
const stones: Stone[] = [];
for (let i = 0; i < 7; i++) {
  const degree = SCALE[Math.floor(rng() * SCALE.length)]!;
  const octave = Math.floor(rng() * 3);
  stones.push({
    params: {
      pitch: ROOT * Math.pow(2, degree / 12 + octave),
      brightness: 0.25 + rng() * 0.7,
      ring: 18 + rng() * 55,
      grain: 260 + rng() * 1800,
      grainRatio: 1.4 + rng() * 3.2,
    },
    pan: rng() * 2 - 1,
    gain: 0.35 + rng() * 0.5,
    strikeAt: i === 2 ? 5.0 : i === 5 ? 8.5 : null,
  });
}

/** The wind rises and falls across the take, the way weather would. */
function windAt(t: number): number {
  const gust = 0.5 + 0.5 * Math.sin((t / DURATION) * Math.PI * 2 - Math.PI / 2);
  return Math.min(1, gust * 1.15);
}

const total = DURATION * SR;
const left = new Float32Array(total);
const right = new Float32Array(total);

// Automation, so the wind actually moves during the take. The lane is
// evaluated per block by the offline renderer, which is the same path a
// hosted automation lane takes.
const windLane = new AutomationLane({
  range: { start: Time.seconds(0), end: Time.seconds(DURATION) },
  points: Array.from({ length: 57 }, (_, i) => {
    const t = i / 56;
    return { t, value: windAt(t * DURATION) };
  }),
});

for (const stone of stones) {
  const rendered = OfflineRenderer.render(resonantStoneMaterial.graph, {
    duration: DURATION,
    sampleRate: SR,
    params: { ...resonantStoneMaterial.snapshotParams(), ...stone.params, velocity: 0 },
    automation: [{ target: 'wind', lane: windLane }],
  });

  // Equal-power pan, the same law the engine's panner uses.
  const angle = ((stone.pan + 1) * Math.PI) / 4;
  const gl = Math.cos(angle) * stone.gain;
  const gr = Math.sin(angle) * stone.gain;
  for (let i = 0; i < total; i++) {
    left[i]! += rendered.samples[i]! * gl;
    right[i]! += rendered.samples[i]! * gr;
  }

  // A struck stone is a second render of the same graph, gated by velocity,
  // mixed in at its moment. In the world this is one voice and a noteOn.
  if (stone.strikeAt !== null) {
    const hit = OfflineRenderer.render(resonantStoneMaterial.graph, {
      duration: 4,
      sampleRate: SR,
      params: { ...resonantStoneMaterial.snapshotParams(), ...stone.params, wind: 0, velocity: 0.9 },
    });
    const offset = Math.floor(stone.strikeAt * SR);
    for (let i = 0; i < hit.samples.length && offset + i < total; i++) {
      left[offset + i]! += hit.samples[i]! * gl;
      right[offset + i]! += hit.samples[i]! * gr;
    }
  }
}

// Normalise to a comfortable level and write 16-bit stereo.
//
// crate's own `encodeWavFloat32` is mono by construction, on purpose: it
// exists for render-diff fixtures, where a second channel would be a second
// thing to disagree about. A preview wants stereo and wants to open in
// anything, so it brings its own eight lines rather than widening a codec
// that is right as it is.
let loudest = 0;
for (let i = 0; i < total; i++) {
  loudest = Math.max(loudest, Math.abs(left[i]!), Math.abs(right[i]!));
}
const norm = loudest > 0 ? 0.85 / loudest : 1;

const bytes = Buffer.alloc(44 + total * 4);
bytes.write('RIFF', 0, 'ascii');
bytes.writeUInt32LE(36 + total * 4, 4);
bytes.write('WAVE', 8, 'ascii');
bytes.write('fmt ', 12, 'ascii');
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20);          // PCM
bytes.writeUInt16LE(2, 22);          // stereo
bytes.writeUInt32LE(SR, 24);
bytes.writeUInt32LE(SR * 4, 28);
bytes.writeUInt16LE(4, 32);
bytes.writeUInt16LE(16, 34);
bytes.write('data', 36, 'ascii');
bytes.writeUInt32LE(total * 4, 40);
const clamp = (v: number) => Math.max(-1, Math.min(1, v * norm));
for (let i = 0; i < total; i++) {
  bytes.writeInt16LE(Math.round(clamp(left[i]!) * 32767), 44 + i * 4);
  bytes.writeInt16LE(Math.round(clamp(right[i]!) * 32767), 46 + i * 4);
}

const out = process.argv[2] ?? 'resonant-stones.wav';
writeFileSync(out, bytes);
console.log(`wrote ${out}: ${stones.length} stones, ${DURATION}s, peak before normalise ${loudest.toFixed(3)}`);
