/**
 * Rendering a track ahead of time with the live voice processor.
 *
 * The point of `BlockGraph` is that nothing about playback is re-implemented:
 * the processor class is the one the worklet bundle registers. So these run
 * core's real worklet entry and check what render-ahead promises: notes land
 * on their times, a render in chunks is the same samples as one in a single
 * pass, and the track's inserts process the instrument.
 */
import { describe, expect, it } from 'vitest';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { AudioScene } from '../../src/AudioScene';
import { Track } from '../../src/graph/Track';
import { MidiClip } from '../../src/graph/MidiClip';
import { Time } from '../../src/Time';
import { env, osc } from '../../src/asl/builders';
import { ASLValue } from '../../src/asl/ASLValue';
import { param } from '../../src/graph/param';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import { captureVoiceProcessor, type VoiceProcessorClass } from '../../src/render/blockGraph';
import { TrackRender, isRenderableTrack } from '../../src/render/trackRender';

const SR = 48000;
let Processor: VoiceProcessorClass;

async function processor(): Promise<VoiceProcessorClass> {
  Processor ??= await captureVoiceProcessor(() => import('../../src/renderers/worklet/crate-voice-processor'), { sampleRate: SR });
  return Processor;
}

const pad = () =>
  new AudioMaterial({
    name: 'Pad',
    polyphony: 2,
    graph: ({ note }) => osc({ freq: new ASLValue(note!.node).toFrequency() }).mul(env.dahdsr({ attack: 0, decay: 0, sustain: 1, release: 0 })).mul(0.5),
  });

const halve = () =>
  new AudioMaterial({ name: 'Half', params: { g: param.range(0, 1, { default: 0.5 }) }, graph: ({ input, params }) => input!.mul(params.g!) });

function song(withInsert = false) {
  const scene = new AudioScene({ createContext: () => ({ sampleRate: SR }) as never });
  scene.transport.bpm = 120;
  const track = scene.addTrack(new Track({ name: 'keys' }));
  track.instrument = pad();
  if (withInsert) track.materials.add(halve());
  // Two quarter notes at 120 bpm: 0.5 s on, at 0.5 s and 1.5 s.
  track.addMidiClip(
    new MidiClip({ notes: [{ pitch: 69, velocity: 1, startBeat: 1, durationBeats: 1 }, { pitch: 72, velocity: 1, startBeat: 3, durationBeats: 1 }] }),
    { at: Time.seconds(0) },
  );
  return { scene, track };
}

const peak = (x: Float32Array, from: number, to: number) => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
};

describe('TrackRender', () => {
  it('knows which tracks it can render', () => {
    const { track } = song();
    expect(isRenderableTrack(track)).toBe(true);
    expect(isRenderableTrack(new Track({ name: 'empty' }))).toBe(false);
  });

  it('plays each note at its time and is silent between them', async () => {
    const { scene, track } = song();
    const render = await TrackRender.create({ Processor: await processor(), sampleRate: SR, track, transport: scene.transport, fromSec: 0, registry: new AudioMaterialRegistry() });
    const [left] = render.render(128 * 750); // 2 s
    expect(peak(left, 0, 0.49 * SR)).toBe(0);
    expect(peak(left, 0.51 * SR, 0.99 * SR)).toBeGreaterThan(0.3);
    expect(peak(left, 1.01 * SR, 1.49 * SR)).toBe(0);
    expect(peak(left, 1.51 * SR, 1.99 * SR)).toBeGreaterThan(0.3);
    render.dispose();
  });

  it('renders the same samples in chunks as in one pass', async () => {
    const { scene, track } = song(true);
    const P = await processor();
    const whole = await TrackRender.create({ Processor: P, sampleRate: SR, track, transport: scene.transport, fromSec: 0, registry: new AudioMaterialRegistry() });
    const pieces = await TrackRender.create({ Processor: P, sampleRate: SR, track, transport: scene.transport, fromSec: 0, registry: new AudioMaterialRegistry() });
    const [a] = whole.render(128 * 600);
    const parts = [pieces.render(128 * 100)[0], pieces.render(128 * 250)[0], pieces.render(128 * 250)[0]];
    const b = new Float32Array(a.length);
    let o = 0;
    for (const p of parts) {
      b.set(p, o);
      o += p.length;
    }
    expect(Array.from(b)).toEqual(Array.from(a));
    // And the insert halved it.
    expect(peak(a, 0.51 * SR, 0.99 * SR)).toBeLessThan(0.3);
    expect(peak(a, 0.51 * SR, 0.99 * SR)).toBeGreaterThan(0.15);
  });

  it('starts mid-song with the notes still to come, on their song times', async () => {
    const { scene, track } = song();
    const render = await TrackRender.create({ Processor: await processor(), sampleRate: SR, track, transport: scene.transport, fromSec: 1.0, registry: new AudioMaterialRegistry() });
    expect(render.positionSec).toBe(1);
    const [left] = render.render(128 * 375); // song 1.0 .. 2.0
    expect(peak(left, 0, 0.49 * SR)).toBe(0); // the first note ended at 1.0
    expect(peak(left, 0.51 * SR, 0.99 * SR)).toBeGreaterThan(0.3); // the second, at 1.5
  });
});
