import type { AudioContextLike } from '../AudioContextLike';
import { applyClipGainAndFades } from '../clip/fades';
import type { AudioBufferLike } from '../graph/Clip';
import type { Bus } from '../graph/Bus';
import type { Track } from '../graph/Track';
import type { AudioMaterial } from '../graph/AudioMaterial';
import { PDC_SCHEDULE_AHEAD_SEC, pdcAudibleOriginSec } from '../host/pdc';
import type { PlaybackPlan, PlannedClipJob } from './plan';
import type { MidiVoiceTarget } from './MidiPlayback';
import type { LiveSceneVoices } from './liveVoices';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';

export interface PlaybackStart {
  originCtx: number;
  audibleOriginCtx: number;
  plan: PlaybackPlan;
  /** Live-bound instrument voices, wrapped as MIDI targets, keyed by track id. Empty unless `liveVoices` was supplied to `start()`. */
  instrumentTargets: Map<number, MidiVoiceTarget>;
  /**
   * Per-track gain node sitting between the clip sources and the track's
   * insert chain, keyed by track id. Clip-level automation (hosted virtual
   * slot -1, address 0) writes here rather than into the track volume gain,
   * so a clip-gain lane and the track fader stay independent, matching the
   * shipped shim's own `trackClipGains`. Empty for fake test contexts.
   */
  clipGainTargets: Map<number, { gain: { value: number } }>;
  /**
   * Live track fader/panner nodes, keyed by track id, so a mixer UI can move
   * volume and pan during playback without re-planning and rescheduling.
   * Empty for fake test contexts.
   */
  trackFaders: Map<number, TrackFader>;
  /** The live master fader, or null for a fake test context. Carries `master.volume` (0 while muted). */
  masterFader: { gain: { value: number } } | null;
  /**
   * Post-volume mix per track (the GainNode behind `trackFaders`), keyed by
   * track id. Hosts tap this for meters without walking the insert chain.
   */
  trackMixNodes: Map<number, unknown>;
}

export interface TrackFader {
  gain: { value: number };
  pan: { value: number };
}

interface ScheduledSource {
  stop(): void;
  disconnect(): void;
}

export interface WebAudioBits {
  currentTime: number;
  sampleRate: number;
  destination: { connect?: unknown };
  createBufferSource(): {
    buffer: unknown;
    playbackRate: { value: number };
    connect(node: unknown): void;
    start(when: number, offset?: number, duration?: number): void;
    stop(): void;
    disconnect(): void;
  };
  createGain(): {
    gain: { value: number };
    connect(node: unknown): void;
    disconnect(): void;
  };
  createStereoPanner(): {
    pan: { value: number };
    connect(node: unknown): void;
    disconnect(): void;
  };
  createBuffer(channels: number, length: number, sampleRate: number): {
    copyToChannel?(data: Float32Array, channel: number): void;
    getChannelData(channel: number): Float32Array;
  };
}

export function asWebAudio(ctx: AudioContextLike): WebAudioBits | null {
  const raw = ctx as AudioContextLike & Partial<WebAudioBits>;
  if (typeof raw.createBufferSource !== 'function' || typeof raw.createGain !== 'function') {
    return null;
  }
  if (typeof raw.createBuffer !== 'function' || !raw.destination) return null;
  return raw as WebAudioBits;
}

export function toNativeBuffer(ctx: WebAudioBits, buffer: AudioBufferLike) {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    if (out.copyToChannel) out.copyToChannel(data, ch);
    else out.getChannelData(ch).set(data);
  }
  return out;
}

/** Wraps a raw live `VoiceHandle` as a `MidiVoiceTarget`, so `MidiPlayback` can dispatch into it without knowing it's a worklet. */
function asMidiTarget(voice: VoiceHandle): MidiVoiceTarget {
  return {
    scheduled: true,
    noteOn: (note, options) => voice.midiNoteOn(note, options?.velocity ?? 1, options?.when),
    noteOff: (note, options) => voice.midiNoteOff(note, options?.when),
    controlChange: (cc, value, options) => voice.midiControlChange(cc, value, options?.when),
    allNotesOff: () => voice.allNotesOff(),
  };
}

/** Connects `voices` in series (declared order, each stage's output feeding the next) ending at `dest`; returns the entry point (the first voice's node, or `dest` when `voices` is empty). */
function chainVoices(voices: VoiceHandle[], dest: unknown): unknown {
  let entry = dest;
  for (let i = voices.length - 1; i >= 0; i--) {
    const node = voices[i]!.node as unknown as { connect(n: unknown): void };
    node.connect(entry);
    entry = voices[i]!.node;
  }
  return entry;
}

/**
 * Schedules a plan onto an AudioContext when the injected context has
 * BufferSource APIs. Fake test contexts still get a plan and an origin;
 * they just do not emit audio.
 *
 * `liveVoices` (from `playback/liveVoices.ts`'s `prepareLiveVoices`, run
 * *before* this synchronous call) are connected in series ahead of each
 * track's gain/pan node, and a track's `instrument` voice joins the same
 * entry point dry clip sources do (so both are exactly one channel, and any
 * insert chain on the track processes either source alike).
 */
export class ScenePlayback {
  lastPlan: PlaybackPlan | null = null;
  lastStart: PlaybackStart | null = null;
  private sources: ScheduledSource[] = [];
  private nodes: Array<{ disconnect(): void }> = [];

  start(
    ctx: AudioContextLike,
    tracks: readonly Track[],
    master: Bus,
    plan: PlaybackPlan,
    buffers: Map<number, AudioBufferLike>,
    liveVoices?: LiveSceneVoices,
  ): PlaybackStart {
    this.stop();
    this.lastPlan = plan;
    const web = asWebAudio(ctx);
    const origin = ctx.currentTime + PDC_SCHEDULE_AHEAD_SEC;
    const audibleOriginCtx =
      origin + pdcAudibleOriginSec(plan.maxTrackLatencySamples, plan.masterLatencySamples, ctx.sampleRate);
    const instrumentTargets = new Map<number, MidiVoiceTarget>();
    const clipGainTargets = new Map<number, { gain: { value: number } }>();
    const trackFaders = new Map<number, TrackFader>();
    const trackMixNodes = new Map<number, unknown>();
    let masterFader: { gain: { value: number } } | null = null;

    if (web) {
      const masterGain = web.createGain();
      masterGain.gain.value = master.muted ? 0 : master.volume;
      masterFader = masterGain;
      masterGain.connect(web.destination);
      this.nodes.push(masterGain);
      // Live voices' *connections* (not the voices themselves) are this
      // class's responsibility to undo on stop(), so replaying the same
      // prepared batch across stop()/start() cycles doesn't pile up
      // duplicate graph edges. The voices' own lifecycle (WASM state,
      // `noteOff`) belongs to whoever called `prepareLiveVoices`
      // (`AudioScene`), via `disposeLiveVoices`.
      if (liveVoices) for (const voice of liveVoices.master) this.nodes.push({ disconnect: () => voice.node.disconnect() });
      const masterEntry = liveVoices ? chainVoices(liveVoices.master, masterGain) : masterGain;

      const clipDest = new Map<number, unknown>();
      const trackTaps = new Map<number, unknown>();
      const trackById = new Map<number, Track>();
      for (const track of tracks) trackById.set(track.id, track);

      /**
       * Builds one track's chain once:
       *   clip sources -> clipGain -> [inserts...] -> gain -> panner -> master
       * with a live instrument voice joining at the same point the inserts
       * read from, so both sources hit the same effects. Returns the node
       * clip sources should connect to.
       */
      const buildTrackEntry = (trackId: number, volume: number, pan: number): unknown => {
        const existing = clipDest.get(trackId);
        if (existing) return existing;
        const gain = web.createGain();
        gain.gain.value = volume;
        const panner = web.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        gain.connect(panner);
        panner.connect(masterEntry);
        this.nodes.push(gain, panner);
        trackFaders.set(trackId, { gain: gain.gain, pan: panner.pan });
        // Post-insert, post-volume, pre-pan: the point a send would tap. Kept
        // so an AudioMaterial on another track can key off this one.
        trackTaps.set(trackId, gain);
        trackMixNodes.set(trackId, gain);

        const live = liveVoices?.tracks.get(trackId);
        let entry: unknown = gain;
        if (live) {
          for (const voice of live.inserts) this.nodes.push({ disconnect: () => voice.node.disconnect() });
          entry = chainVoices(live.inserts, gain);
          if (live.instrument) {
            (live.instrument.node as unknown as { connect(n: unknown): void }).connect(entry);
            this.nodes.push({ disconnect: () => live.instrument!.node.disconnect() });
            instrumentTargets.set(trackId, asMidiTarget(live.instrument));
          }
        }

        const clipGain = web.createGain();
        clipGain.gain.value = 1;
        clipGain.connect(entry);
        this.nodes.push(clipGain);
        clipGainTargets.set(trackId, clipGain);
        clipDest.set(trackId, clipGain);
        return clipGain;
      };

      // Build every live-voiced track's chain eagerly, even one with no dry
      // clip jobs in this plan (e.g. an instrument-only track whose notes
      // haven't started yet still needs its voice connected and ready).
      if (liveVoices) {
        for (const [trackId, live] of liveVoices.tracks) {
          if (live.inserts.length === 0 && !live.instrument) continue;
          const track = trackById.get(trackId);
          buildTrackEntry(trackId, track?.volume ?? 1, track?.pan ?? 0);
        }
      }

      // Second audio inputs, once every chain that could be a source exists.
      // An AudioMaterial declares where its sidechain comes from (`AudioMaterial.
      // setAudioSource`); this is the only place that knows what node that
      // actually is. Done in its own pass because the source track may sit
      // later in the list than the AudioMaterial keying off it, and may have no
      // clips of its own at all.
      if (liveVoices) {
        const wireAux = (material: AudioMaterial, voice: VoiceHandle): void => {
          for (const [port, source] of material.audioSources) {
            let tap: unknown;
            if (source.kind === 'master') {
              tap = masterEntry;
            } else {
              const sourceTrack = trackById.get(source.trackId);
              buildTrackEntry(source.trackId, sourceTrack?.volume ?? 1, sourceTrack?.pan ?? 0);
              tap = trackTaps.get(source.trackId);
            }
            if (!tap) continue;
            let index: number;
            try {
              index = voice.inputIndexFor(port);
            } catch {
              // The AudioMaterial declares a source for a port its graph does not
              // read. Skipping is right: connecting to input 0 would mix the
              // key signal into the audio.
              continue;
            }
            const from = tap as {
              connect(node: unknown, output?: number, input?: number): void;
              disconnect(node?: unknown): void;
            };
            from.connect(voice.node, 0, index);
            this.nodes.push({ disconnect: () => from.disconnect(voice.node) });
          }
        };

        for (let i = 0; i < master.materials.list.length; i++) {
          const voice = liveVoices.master[i];
          if (voice) wireAux(master.materials.list[i]!, voice);
        }
        for (const [trackId, live] of liveVoices.tracks) {
          const materials = trackById.get(trackId)?.materials.list ?? [];
          for (let i = 0; i < materials.length; i++) {
            const voice = live.inserts[i];
            if (voice) wireAux(materials[i]!, voice);
          }
          if (live.instrument && trackById.get(trackId)?.instrument) {
            wireAux(trackById.get(trackId)!.instrument!, live.instrument);
          }
        }
      }

      const destFor = (job: PlannedClipJob) => buildTrackEntry(job.trackId, job.volume, job.pan);

      const pending: Array<{
        source: ReturnType<WebAudioBits['createBufferSource']>;
        job: PlannedClipJob;
      }> = [];

      for (const job of plan.jobs) {
        const raw = buffers.get(job.clipId);
        if (!raw) continue;
        const source = web.createBufferSource();
        const faded = applyClipGainAndFades(raw, {
          gainDb: job.gainDb,
          fadeInSec: job.fadeInSec,
          fadeOutSec: job.fadeOutSec,
          fadeInCurve: job.fadeInCurve,
          fadeOutCurve: job.fadeOutCurve,
          trimStartSec: job.trimStartSec,
          trimEndSec: job.trimEndSec,
          playbackRate: job.playbackRate,
        });
        source.buffer = toNativeBuffer(web, faded);
        source.playbackRate.value = job.playbackRate;
        source.connect(destFor(job));
        pending.push({ source, job });
        this.sources.push(source);
      }

      for (const { source, job } of pending) {
        try {
          source.start(origin + job.whenSec + job.pdcSec, job.fileOffsetSec, job.fileDurationSec);
        } catch (err) {
          console.warn(
            `[crate] clip start failed when=${(origin + job.whenSec).toFixed(3)} offset=${job.fileOffsetSec.toFixed(3)} dur=${job.fileDurationSec.toFixed(3)}`,
            err,
          );
        }
      }
    }

    const start: PlaybackStart = {
      originCtx: origin,
      audibleOriginCtx,
      plan,
      instrumentTargets,
      clipGainTargets,
      trackFaders,
      trackMixNodes,
      masterFader,
    };
    this.lastStart = start;
    return start;
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.sources = [];
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes = [];
  }
}
