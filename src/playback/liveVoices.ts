import { audioMaterialRegistry, type AudioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import type { ASLGraphDescriptor } from '../asl/graph';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';
import type { KernelBinaryMap } from '../renderers/kernel';
import type { AudioMaterial } from '../graph/AudioMaterial';
import type { Track } from '../graph/Track';
import type { Bus } from '../graph/Bus';

/**
 * The slice of `WebAudioRenderer` live-voice binding needs, matching this
 * package's usual DI pattern so tests can inject a fake renderer/voice pair
 * (real `AudioWorkletNode`s only exist in a browser, same constraint
 * `WebAudioRenderer` itself documents).
 */
export interface LiveVoiceRenderer {
  /**
   * The graph is the whole request: how many audio inputs the voice needs is
   * read off it (`asl/ports.ts`), not passed alongside it, so an AudioMaterial that
   * grows a sidechain does not also have to be wired differently here.
   */
  createVoice(graph: ASLGraphDescriptor): Promise<VoiceHandle>;
}

/**
 * Bulk payloads (in practice WASM binaries) a host fetched on the main
 * thread, keyed by kernel slot. Crate passes the whole map through to each
 * plugin's `bindLiveVoice`, which pulls out the ones it needs. Crate itself
 * never reads a key, so adding a plugin adds no field here.
 */
export type LiveWasmBinaries = KernelBinaryMap;

export interface LiveTrackVoices {
  /** Index-aligned with `track.materials.list`. */
  inserts: VoiceHandle[];
  instrument?: VoiceHandle;
}

export interface LiveSceneVoices {
  /** Index-aligned with `scene.master.materials.list`. */
  master: VoiceHandle[];
  tracks: Map<number, LiveTrackVoices>;
}

/**
 * One live voice for an AudioMaterial: created, given its current param snapshot,
 * then handed to whichever plugin owns it so that plugin can load its kernels
 * and push its hydrated assets. Not connected to anything yet, connecting is
 * `ScenePlayback`'s job, once the destination nodes it needs exist.
 *
 * This function used to branch on `material.name === 'Amp'` and friends. It
 * now knows nothing about any AudioMaterial: an AudioMaterial whose plugin is not
 * registered, or whose plugin has no `bindLiveVoice`, still gets a working
 * voice running its plain ASL graph, which is the correct behavior for a pure
 * ASL AudioMaterial and a survivable one for a plugin that failed to register.
 *
 * Instrument and insert voices are the same call. The role difference is
 * where `ScenePlayback` connects them, not how they are built.
 */
async function createVoiceFor(
  renderer: LiveVoiceRenderer,
  material: AudioMaterial,
  wasm: LiveWasmBinaries,
  registry: AudioMaterialRegistry,
): Promise<VoiceHandle> {
  const voice = await renderer.createVoice(material.graph);
  voice.noteOn(material.snapshotParams());
  const plugin = registry.forMaterial(material);
  if (plugin?.bindLiveVoice) {
    await plugin.bindLiveVoice(voice, material, wasm);
  }
  return voice;
}

/**
 * Creates every live voice a scene's current tracks/master need, ahead of
 * `transport.play()`. Must run first and be awaited: `AudioWorkletNode`
 * creation is inherently async (a Web Audio API constraint, not a crate
 * one), and `transport.play()`/`AudioScene.beginPlayback` stay fully
 * synchronous (same "no await inside sync play()" rule `bakeTrackInserts`
 * already established). `ScenePlayback.start()` only connects these
 * pre-built voices into the graph, a synchronous operation.
 *
 * No cache invalidation, same contract as `AudioScene.prepareTrackInserts`:
 * call again after changing a track's materials/instrument, before the next
 * `play()`.
 */
export async function prepareLiveVoices(
  renderer: LiveVoiceRenderer,
  tracks: readonly Track[],
  master: Bus,
  wasm: LiveWasmBinaries = {},
  registry: AudioMaterialRegistry = audioMaterialRegistry,
): Promise<LiveSceneVoices> {
  const masterVoices: VoiceHandle[] = [];
  for (const material of master.materials) {
    masterVoices.push(await createVoiceFor(renderer, material, wasm, registry));
  }

  const tracksMap = new Map<number, LiveTrackVoices>();
  for (const track of tracks) {
    const inserts: VoiceHandle[] = [];
    for (const material of track.materials) {
      inserts.push(await createVoiceFor(renderer, material, wasm, registry));
    }
    const instrument = track.instrument
      ? await createVoiceFor(renderer, track.instrument, wasm, registry)
      : undefined;
    tracksMap.set(track.id, { inserts, instrument });
  }

  return { master: masterVoices, tracks: tracksMap };
}

/** Tears down every voice `prepareLiveVoices` created. Safe to call more than once. */
export function disposeLiveVoices(voices: LiveSceneVoices): void {
  const all = [...voices.master];
  for (const track of voices.tracks.values()) {
    all.push(...track.inserts);
    if (track.instrument) all.push(track.instrument);
  }
  for (const voice of all) {
    try {
      voice.noteOff();
      voice.node.disconnect();
      try {
        voice.driver?.stop();
        voice.driver?.disconnect();
      } catch {
        /* already stopped */
      }
    } catch {
      /* already gone */
    }
  }
}
