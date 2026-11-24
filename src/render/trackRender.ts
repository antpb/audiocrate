/**
 * One track rendered ahead of time: its instrument playing its MIDI, through
 * its inserts, from a song position on, continuously.
 *
 * What a live play of that track would send its voices, sent to the same
 * voices on a `BlockGraph`: `prepareLiveVoices` builds them (kernels and
 * pools as live), the plan is `planScenePlayback`'s for this track alone,
 * notes go out with their times through the same targets ScenePlayback uses,
 * and the transport is anchored where the render starts. The track's fader,
 * pan and mute are not applied: the live scene keeps those, so a mixer still
 * works on a rendered track.
 */
import type { Track } from '../graph/Track';
import { Bus } from '../graph/Bus';
import type { Transport } from '../Transport';
import type { TransportAnchor } from '../asl/transportNodes';
import { planScenePlayback } from '../playback/plan';
import { prepareLiveVoices, disposeLiveVoices, type LiveSceneVoices } from '../playback/liveVoices';
import { scheduledPoolTarget } from '../playback/scheduledPool';
import type { MidiVoiceTarget } from '../playback/MidiPlayback';
import type { KernelBinaryMap } from '../renderers/kernel';
import { audioMaterialRegistry, type AudioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import { BlockGraph, type BlockNode, type VoiceProcessorClass } from './blockGraph';

export interface TrackRenderOptions {
  /** The voice processor class (`captureVoiceProcessor`), with every kernel the track needs. */
  Processor: VoiceProcessorClass;
  sampleRate: number;
  track: Track;
  /** The scene's transport: tempo, tempo map, meter, and how positions resolve. */
  transport: Transport;
  /** Where in the song (seconds) the render starts. */
  fromSec: number;
  binaries?: KernelBinaryMap;
  registry?: AudioMaterialRegistry;
}

/** Whether a track can be rendered ahead: it plays MIDI through an instrument and has no audio clips. */
export function isRenderableTrack(track: Track): boolean {
  return !!track.instrument && track.midiClips.length > 0 && track.clips.length === 0 && track.streams.length === 0;
}

function anchorAt(transport: Transport, fromSec: number): TransportAnchor {
  const map = transport.tempoMap;
  const beats = map ? map.beatAtSeconds(fromSec) : (fromSec * transport.bpm) / 60;
  const bpm = transport.bpmAt(fromSec);
  const span = map?.segmentAt(beats);
  const changes = map
    ? map.segmentsFromBeat(beats).map((segment) => ({
        atTime: segment.atSeconds - fromSec,
        beats: segment.atBeat,
        bpm: segment.bpm,
        ...(segment.slope !== 0 ? { slope: segment.slope } : {}),
      }))
    : [];
  return {
    atTime: 0,
    beats,
    bpm,
    playing: true,
    beatsPerBar: transport.beatsPerBar,
    beatUnit: transport.beatUnit,
    ...(span && span.slope !== 0 ? { slope: span.slope } : {}),
    ...(changes.length > 0 ? { changes } : {}),
  } as TransportAnchor;
}

export class TrackRender {
  /** Song time (seconds) of the next frame `render` returns. */
  get positionSec(): number {
    return this.fromSec + this.graph.time;
  }

  private constructor(
    private readonly graph: BlockGraph,
    private readonly voices: LiveSceneVoices,
    private readonly fromSec: number,
  ) {}

  static async create(options: TrackRenderOptions): Promise<TrackRender> {
    const { track, transport, sampleRate } = options;
    const registry = options.registry ?? audioMaterialRegistry;
    const graph = new BlockGraph(options.Processor, sampleRate);
    const voices = await prepareLiveVoices(graph, [track], new Bus(), options.binaries ?? {}, registry);
    const live = voices.tracks.get(track.id);
    const render = new TrackRender(graph, voices, Math.max(0, options.fromSec));
    if (!live) return render;

    // inserts in series into the output; the instrument (or its pool) into the first.
    let entry: BlockNode = graph.output;
    for (let i = live.inserts.length - 1; i >= 0; i--) {
      const node = live.inserts[i]!.node as unknown as BlockNode;
      node.connect(entry);
      entry = node;
    }
    let target: MidiVoiceTarget | null = null;
    if (live.instrument) {
      (live.instrument.node as unknown as BlockNode).connect(entry);
      const voice = live.instrument;
      target = {
        scheduled: true,
        noteOn: (note, o) => voice.midiNoteOn(note, o?.velocity ?? 1, o?.when),
        noteOff: (note, o) => voice.midiNoteOff(note, o?.when),
        controlChange: (cc, value, o) => voice.midiControlChange(cc, value, o?.when),
        allNotesOff: () => voice.allNotesOff(),
      };
    } else if (live.instrumentPool) {
      for (const output of live.instrumentPool.outputs) (output.node as unknown as BlockNode).connect(entry);
      target = scheduledPoolTarget(live.instrumentPool.material, live.instrumentPool.voices, () => graph.time);
    }

    const anchor = anchorAt(transport, render.fromSec);
    const handles = [...live.inserts, ...(live.instrument ? [live.instrument] : [])];
    if (live.instrumentPool) handles.push(...live.instrumentPool.voices, ...(live.instrumentPool.bus ? [live.instrumentPool.bus] : []));
    for (const handle of handles) handle.setTransport(anchor);

    if (target) {
      const plan = planScenePlayback({
        tracks: [track],
        master: new Bus(),
        timeContext: transport.timeContext,
        resolveOffsetSec: (t, i) => transport.resolve(t.clips[i]!.at),
        resolveMidiOffsetSec: (t, i) => transport.resolve(t.midiClips[i]!.at),
        playheadSec: render.fromSec,
        sampleRate,
      });
      for (const job of plan.midiJobs) {
        target.noteOn(job.pitch, { velocity: job.velocity, when: Math.max(0, job.onSec) });
        target.noteOff(job.pitch, { when: job.offSec });
      }
      for (const job of plan.midiCcJobs) target.controlChange?.(job.cc, job.value, { when: Math.max(0, job.atSec) });
      // A pool chooses its voices once it has every note (a microtask).
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    return render;
  }

  /** Renders `frames` (a multiple of 128) of stereo audio. */
  render(frames: number): [Float32Array, Float32Array] {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const block = this.graph.blockSize;
    for (let offset = 0; offset < frames; offset += block) {
      const [l, r] = this.graph.renderBlock();
      left.set(l.subarray(0, Math.min(block, frames - offset)), offset);
      right.set(r.subarray(0, Math.min(block, frames - offset)), offset);
    }
    return [left, right];
  }

  /** Renders and drops audio up to song time `sec`, for a render that started early (pre-roll). */
  skipTo(sec: number): void {
    while (this.positionSec + this.graph.blockSize / this.graph.sampleRate <= sec) this.graph.renderBlock();
  }

  dispose(): void {
    disposeLiveVoices(this.voices);
  }
}
