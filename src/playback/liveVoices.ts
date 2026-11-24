import { audioMaterialRegistry, type AudioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import type { ASLGraphDescriptor } from '../asl/graph';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';
import type { KernelBinaryMap } from '../renderers/kernel';
import type { AudioMaterial } from '../graph/AudioMaterial';
import type { Track } from '../graph/Track';
import type { Bus } from '../graph/Bus';
import { connectSplitVoices } from '../renderers/splitVoices';

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
  createVoice(
    graph: ASLGraphDescriptor,
    options?: { params?: Record<string, number>; sends?: boolean },
  ): Promise<VoiceHandle>;
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
  /** A kernel instrument: one voice that takes MIDI and does its own polyphony. */
  instrument?: VoiceHandle;
  /**
   * A pure ASL instrument (no kernel): `polyphony` voices, plus the bus voice
   * of a split instrument, played by `scheduledPoolTarget`. `outputs` are the
   * nodes that reach the track (the bus when there is one, else every voice).
   */
  instrumentPool?: LiveInstrumentPool;
}

export interface LiveInstrumentPool {
  material: AudioMaterial;
  voices: VoiceHandle[];
  bus?: VoiceHandle;
  outputs: VoiceHandle[];
}

export interface PrepareLiveVoicesOptions {
  /**
   * Play pure ASL instruments (a crate patch, the drum) from the scene's MIDI
   * clips through a voice pool. On by default. A host that voices those
   * instruments itself (the patch editor's timeline) turns it off, and then
   * the drum gets no voice here and any other pure ASL instrument gets the
   * single voice it always did.
   */
  poolInstruments?: boolean;
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
  // The values go with the voice as well as with the note: the note is a
  // message, and the first block can run before it lands.
  const plugin = registry.forMaterial(material);
  const graph = plugin?.liveGraph?.(material) ?? material.graph;
  const voice = await renderer.createVoice(graph, { params: material.snapshotParams() });
  voice.noteOn(material.snapshotParams());
  if (plugin?.bindLiveVoice) {
    await plugin.bindLiveVoice(voice, material, wasm);
  }
  return voice;
}

/**
 * The voices for a pure ASL instrument: one per note of polyphony, and for a
 * split instrument (voices summed into one bus, `flattenPatch`'s voicing) the
 * bus voice they feed, wired the way `AudioMaterial.bind` wires them.
 */
async function createInstrumentPool(
  renderer: LiveVoiceRenderer,
  material: AudioMaterial,
  registry: AudioMaterialRegistry,
): Promise<LiveInstrumentPool> {
  const params = material.snapshotParams();
  const graph = registry.forMaterial(material)?.liveGraph?.(material) ?? material.graph;
  const split = graph.bus && graph.sends ? graph.sends.length : 0;
  const voices: VoiceHandle[] = [];
  for (let i = 0; i < material.polyphony; i++) {
    voices.push(await renderer.createVoice(graph, { params, ...(split > 0 ? { sends: true } : {}) }));
  }
  if (split === 0) return { material, voices, outputs: voices };
  const bus = await renderer.createVoice(graph.bus!, { params });
  // An effect on the voices' sum: its gate opens once and stays open.
  bus.noteOn(params);
  connectSplitVoices(voices, bus, split);
  return { material, voices, bus, outputs: [bus] };
}

/** Whether an instrument is played as a pool here: no plugin of its own binds a live voice. */
function isPooledInstrument(material: AudioMaterial, registry: AudioMaterialRegistry): boolean {
  return !registry.forMaterial(material)?.bindLiveVoice;
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
  options: PrepareLiveVoicesOptions = {},
): Promise<LiveSceneVoices> {
  const pool = options.poolInstruments !== false;
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
    if (track.instrument && pool && isPooledInstrument(track.instrument, registry)) {
      tracksMap.set(track.id, { inserts, instrumentPool: await createInstrumentPool(renderer, track.instrument, registry) });
      continue;
    }
    // A host voicing instruments itself (poolInstruments false: the patch
    // editor) plays the drum its own way, so it gets no voice here.
    const instrument =
      track.instrument && (pool || track.instrument.kind !== 'drum')
        ? await createVoiceFor(renderer, track.instrument, wasm, registry)
        : undefined;
    tracksMap.set(track.id, { inserts, instrument });
  }

  return { master: masterVoices, tracks: tracksMap };
}

/**
 * Stops one live worklet so a later Play cannot keep evaluating it.
 *
 * `AudioWorkletNode.process` keeps running while the silent driver is
 * connected, even after every output is disconnected. Leaving that driver
 * up is how Play/Stop/Play stacked two graphs and the mix started skipping.
 */
export function disposeVoiceHandle(voice: VoiceHandle): void {
  try {
    voice.setAnalysisInterval(0);
  } catch {
    /* already gone */
  }
  try {
    voice.allNotesOff();
  } catch {
    /* already gone */
  }
  try {
    voice.noteOff();
  } catch {
    /* already gone */
  }
  try {
    voice.node.disconnect();
  } catch {
    /* already gone */
  }
  // Disconnecting does not stop a processor that keeps returning true; this
  // does, and it is what lets the browser free it. Without it every voice a
  // session ever built kept a place on the audio thread, and a long patching
  // session slowly ran it out of time.
  try {
    voice.node.port.postMessage({ type: 'dispose' });
  } catch {
    /* already gone */
  }
  try {
    voice.driver?.stop();
    voice.driver?.disconnect();
  } catch {
    /* already stopped */
  }
}

/** Tears down every voice `prepareLiveVoices` created. Safe to call more than once. */
export function disposeLiveVoices(voices: LiveSceneVoices): void {
  const all = [...voices.master];
  for (const track of voices.tracks.values()) {
    all.push(...track.inserts);
    if (track.instrument) all.push(track.instrument);
    if (track.instrumentPool) {
      all.push(...track.instrumentPool.voices);
      if (track.instrumentPool.bus) all.push(track.instrumentPool.bus);
    }
  }
  for (const voice of all) disposeVoiceHandle(voice);
}
