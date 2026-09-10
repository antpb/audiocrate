/**
 * Interpreter microbenchmark for `asl/compile.ts`.
 *
 * A fixed graph rendered offline: no browser, no worklet, no AudioContext,
 * sample-accurate, and the same `renderBlock` the audio thread calls.
 *
 * Build and run:
 *   npx esbuild scripts/bench-asl.ts --bundle --format=esm --platform=node \
 *     --outfile=/tmp/bench-asl.mjs && node /tmp/bench-asl.mjs
 *
 * The number that matters is **realtime factor**: how many seconds of audio
 * one second of CPU renders. A voice at 50x can have 50 of itself on a core
 * before the quantum is full, minus everything else the machine is doing.
 * Compare runs on the same machine in the same session; absolute values move
 * with the JIT, the ratio between two builds does not.
 */
import { compileVoice } from '../src/asl/compile';
import { ASL } from '../src/asl/graph';
import {
  audio,
  clip,
  compressor,
  delay,
  env,
  filter,
  lfo,
  mix,
  osc,
  panLaw,
  peak,
  uniform,
} from '../src/asl/builders';
import { tap } from '../src/asl/analysis';
import type { ASLGraphDescriptor } from '../src/asl/graph';

const SR = 48000;
const BLOCK = 128;

interface Case {
  readonly name: string;
  readonly note: string;
  readonly graph: ASLGraphDescriptor;
  /**
   * How this case is fed: nothing (a source), a mono track's block, or a
   * real stereo pair. Mono and stereo are different amounts of work for the
   * same graph, so an insert benchmark has to say which it measured.
   */
  readonly insert: 'none' | 'mono' | 'stereo';
}

const cases: Case[] = [
  {
    name: 'osc',
    note: 'one saw. The floor: what an empty interpreter walk costs.',
    insert: 'none',
    graph: ASL.node(({ note }) => osc({ freq: note.toFrequency(), type: 'saw' })),
  },
  {
    name: 'synth-voice',
    note: 'Starter patch: osc + ADSR + lowpass + delay. The patcher default.',
    insert: 'none',
    graph: ASL.node(({ note, cutoff }) =>
      delay(
        filter.lowpass(
          osc({ freq: note.toFrequency(), type: 'saw' }).mul(env.adsr({ a: 0.01, d: 0.2, s: 0.6, r: 0.3 })),
          { cutoff, q: uniform(0.9) },
        ),
        { timeSec: uniform(0.25), feedback: uniform(0.35), mix: uniform(0.3), maxTimeSec: 2 },
      ),
    ),
  },
  {
    name: 'lfo-cutoff',
    note: 'Same filter with the cutoff swept every sample. Coefficients cannot be cached.',
    insert: 'none',
    graph: ASL.node(({ note }) =>
      filter.lowpass(osc({ freq: note.toFrequency(), type: 'saw' }), {
        cutoff: lfo({ rate: uniform(3) }).range(200, 6000),
        q: uniform(0.9),
      }),
    ),
  },
  {
    name: 'insert-tail',
    note: 'The ASL tail behind a kernel: comp, gain, pan, limiter, meter. Stereo.',
    insert: 'stereo',
    graph: ASL.node(({ gain, pan }) =>
      tap.meter(
        panLaw(
          clip(
            compressor(audio.input(), {
              threshold: uniform(0.3),
              ratio: uniform(4),
              attack: uniform(0.005),
              release: uniform(0.15),
            }).mul(gain),
            { drive: uniform(1.4), mode: 'soft' },
          ),
          { pan, channel: 'left' },
        ),
        { id: 'out' },
      ),
    ),
  },
  {
    name: 'eq-4band',
    note: 'Four biquads in series with fixed settings. Every one recomputes its coefficients.',
    insert: 'stereo',
    graph: ASL.node(() =>
      filter.highshelf(
        filter.peaking(
          filter.peaking(filter.lowshelf(audio.input(), { freq: uniform(120), gainDb: uniform(3), q: uniform(0.707) }), {
            freq: uniform(600),
            gainDb: uniform(-2),
            q: uniform(1.1),
          }),
          { freq: uniform(2400), gainDb: uniform(2.5), q: uniform(1.4) },
        ),
        { freq: uniform(8000), gainDb: uniform(1.5), q: uniform(0.707) },
      ),
    ),
  },
  {
    name: 'tall-chain',
    note: 'Twenty arithmetic nodes over a shared source. Measures the walk itself, not the DSP.',
    insert: 'stereo',
    graph: ASL.node(({ gain }) => {
      const source = audio.input();
      let value = source;
      for (let i = 0; i < 20; i++) value = value.mul(gain).add(source.mul(0.001 * i));
      return value;
    }),
  },
  {
    name: 'eq-4band-mono',
    note: 'The same four bands on a mono track, where the right pass is the left pass again.',
    insert: 'mono',
    graph: ASL.node(() =>
      filter.highshelf(
        filter.peaking(
          filter.peaking(filter.lowshelf(audio.input(), { freq: uniform(120), gainDb: uniform(3), q: uniform(0.707) }), {
            freq: uniform(600),
            gainDb: uniform(-2),
            q: uniform(1.1),
          }),
          { freq: uniform(2400), gainDb: uniform(2.5), q: uniform(1.4) },
        ),
        { freq: uniform(8000), gainDb: uniform(1.5), q: uniform(0.707) },
      ),
    ),
  },
  {
    name: 'meters',
    note: 'Peak follower plus two taps: what a metered master bus pays.',
    insert: 'stereo',
    graph: ASL.node(() => {
      const input = audio.input();
      return tap.meter(mix(tap.capture(input, { id: 'scope', windowSize: 1024 }), peak(input).mul(0)), {
        id: 'level',
      });
    }),
  },
];

function bench(c: Case, seconds: number): { rtf: number; msPerBlock: number } {
  const voice = compileVoice(c.graph);
  const state = voice.createState();
  state.params.note = 57;
  state.params.cutoff = 1800;
  state.params.gain = 0.8;
  state.params.pan = -0.2;
  voice.noteOn(state, {});

  const out = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const input = new Float32Array(BLOCK);
  const inputR = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    input[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.4;
    inputR[i] = input[i]! * 0.9;
  }
  const extras =
    c.insert === 'stereo'
      ? { inputR, outputR: outR }
      : c.insert === 'mono'
        ? { outputR: outR }
        : undefined;
  const feed = c.insert === 'none' ? undefined : input;
  const blocks = Math.round((seconds * SR) / BLOCK);

  // Warm the JIT on the same shapes the timed loop uses.
  for (let b = 0; b < 400; b++) voice.renderBlock(state, SR, out, feed, extras);

  const started = process.hrtime.bigint();
  for (let b = 0; b < blocks; b++) {
    voice.renderBlock(state, SR, out, feed, extras);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // Guard against a graph that optimised itself into silence.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += Math.abs(out[i]!);
  if (!Number.isFinite(sum)) throw new Error(`${c.name} produced a non-finite block`);

  return { rtf: (blocks * BLOCK) / SR / (elapsedMs / 1000), msPerBlock: elapsedMs / blocks };
}

const seconds = Number(process.argv[2] ?? 4);
const only = process.argv[3];
const quantumMs = (BLOCK / SR) * 1000;

console.log(`asl interpreter, ${SR} Hz, ${BLOCK}-frame blocks (${quantumMs.toFixed(2)} ms quantum), ${seconds}s per case\n`);
console.log('case             realtime   ms/block   voices/core   note');
for (const c of cases.filter((x) => !only || x.name === only)) {
  const { rtf, msPerBlock } = bench(c, seconds);
  console.log(
    `${c.name.padEnd(16)} ${(rtf.toFixed(1) + 'x').padStart(8)} ${msPerBlock.toFixed(4).padStart(10)} ${String(
      Math.floor(quantumMs / msPerBlock),
    ).padStart(13)}   ${c.note}`,
  );
}
