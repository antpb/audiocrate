import { TempoMap, type TempoChange, type TempoCurve } from '../TempoMap';
import { AudioScene } from '../AudioScene';
import { fadeCurveName } from '../clip/fades';
import { Track } from '../graph/Track';
import { Clip } from '../graph/Clip';
import { MidiClip, type MidiCcLane, type MidiNote } from '../graph/MidiClip';
import { Time } from '../Time';
import { decodeAudioFile } from './AudioLoader';
import { listPluginSlots, resolveProjectAssetPath } from '../host/pluginSlots';
import { mapPluginSlot } from '../host/mapPluginSlot';
import { HOSTED_MASTER_TRACK_INDEX } from '../automation/hosted';
import { audioMaterialRegistry, type AudioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import type { AssetRequest, AudioAssetData, TextAssetData } from '../graph/assets';
import type { AudioMaterial } from '../graph/AudioMaterial';

/**
 * Reads a homecrate project archive. Every interface here is a partial
 * typed view over the real schema (an index signature keeps every field
 * this package does not model, e.g. plugin slots' AUv3 preset blobs, MIDI
 * clip note data, automation lanes, key/scale, section markers): a parsed
 * `ProjectFileData` is the same object `JSON.parse` produced, just typed, so
 * `JSON.stringify(parsed.project)` after only touching fields crate actually
 * understands reproduces everything else byte-for-byte.
 *
 * The archive is a plain directory (manifest.json + project.json + audio/ +
 * assets/ + artwork/), matching an already-extracted homecrate project
 * export; unzipping a `.zip` export into that shape is a thin wrapper this
 * doesn't build (v0.x scope cut: nothing here needs it to work against a
 * real exported project).
 */

export interface ProjectClipData {
  id: string;
  audioFileUri?: string;
  monoAudioFileUri?: string;
  recordingName?: string;
  offsetMs: number;
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeInCurve?: string;
  fadeOutCurve?: string;
  clipGainDb?: number;
  crossfadeToNextMs?: number;
  crossfadeCurve?: string;
  [key: string]: unknown;
}

export interface ProjectTrackData {
  id: string;
  trackIndex: number;
  clips: ProjectClipData[];
  volume: number;
  pan: number;
  isMuted: boolean;
  [key: string]: unknown;
}

export interface ProjectMidiNoteData {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  repeatCount?: number;
  repeatSpacing?: number;
  [key: string]: unknown;
}

export interface ProjectMidiClipData {
  id?: string;
  offsetMs?: number;
  payload?: { notes?: ProjectMidiNoteData[]; bars?: number; [key: string]: unknown };
  notes?: ProjectMidiNoteData[];
  [key: string]: unknown;
}

export interface ProjectMidiTrackData {
  trackIndex: number;
  instrumentTrackId: string | null;
  clips: ProjectMidiClipData[];
  isMuted?: boolean;
  [key: string]: unknown;
}

export interface ProjectMasterData {
  volume: number;
  muted: boolean;
  [key: string]: unknown;
}

/** One tempo change as it appears in `project.json`. */
export interface ProjectTempoChangeData {
  atBeat: number;
  bpm: number;
  curve?: TempoCurve;
  [key: string]: unknown;
}

export interface ProjectFileData {
  id: string;
  name: string;
  bpm: number;
  /**
   * Optional tempo changes, in beats from the timeline origin.
   *
   * **`bpm` stays authoritative for the tempo the song starts at**, so a
   * reader that knows nothing about this field still opens the project at the
   * right tempo instead of at a default. That is the same append-only rule
   * the collab wire follows, and it is what lets one format serve two
   * versions of an application.
   *
   * Absent means constant tempo, and a project without it loads through
   * exactly the path it did before tempo maps existed.
   */
  tempoChanges?: ProjectTempoChangeData[];
  timeSigN: number;
  timeSigD: number;
  tracks: ProjectTrackData[];
  midiTracks: ProjectMidiTrackData[];
  master: ProjectMasterData;
  [key: string]: unknown;
}

export interface ProjectManifestData {
  kind: string;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  projectId: string;
  projectName: string;
  counts: { audioFiles: number; artworkFiles: number; assetFiles: number };
  [key: string]: unknown;
}

export interface ParsedProject {
  manifest: ProjectManifestData;
  project: ProjectFileData;
}

/** What `readProjectTempoMap` found, including what it could not use. */
export interface ProjectTempoMapResult {
  /** Null when the project is a single constant tempo, which is the common case. */
  map: TempoMap | null;
  /** The changes that were well formed, sorted. */
  changes: TempoChange[];
  /**
   * Entries that were not usable, with the reason.
   *
   * Reported rather than thrown, because a project file is data from disk
   * that some other version may have written, and losing a whole song to one
   * malformed entry is worse than losing the entry. Reported rather than
   * dropped silently, because a song that plays at the wrong tempo with no
   * explanation is the harder bug of the two.
   */
  skipped: { index: number; reason: string }[];
}

/**
 * Reads a project's tempo map. `project.bpm` is the base tempo, so a project
 * with no changes gives a null map and the caller keeps doing what it did.
 */
export function readProjectTempoMap(project: ProjectFileData): ProjectTempoMapResult {
  const raw = project.tempoChanges;
  const skipped: { index: number; reason: string }[] = [];
  if (raw === undefined || raw === null) return { map: null, changes: [], skipped };
  if (!Array.isArray(raw)) {
    return { map: null, changes: [], skipped: [{ index: -1, reason: 'tempoChanges is not an array' }] };
  }

  const changes: TempoChange[] = [];
  raw.forEach((entry, index) => {
    const reason = tempoChangeProblem(entry);
    if (reason) {
      skipped.push({ index, reason });
      return;
    }
    const change = entry as ProjectTempoChangeData;
    changes.push({
      atBeat: change.atBeat,
      bpm: change.bpm,
      ...(change.curve !== undefined ? { curve: change.curve } : {}),
    });
  });

  if (changes.length === 0) return { map: null, changes, skipped };
  const base = typeof project.bpm === 'number' && project.bpm > 0 ? project.bpm : 120;
  return { map: new TempoMap(changes, base), changes, skipped };
}

function tempoChangeProblem(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return 'not an object';
  const change = entry as Record<string, unknown>;
  if (typeof change.atBeat !== 'number' || !Number.isFinite(change.atBeat)) {
    return 'atBeat is not a finite number';
  }
  if (change.atBeat < 0) return 'atBeat is negative';
  if (typeof change.bpm !== 'number' || !Number.isFinite(change.bpm) || change.bpm <= 0) {
    return 'bpm is not a positive finite number';
  }
  if (change.curve !== undefined && change.curve !== 'jump' && change.curve !== 'ramp') {
    return `curve is not 'jump' or 'ramp'`;
  }
  return null;
}

/**
 * Writes a tempo map into a project object, in place.
 *
 * A constant map removes the field rather than writing an empty array, so a
 * project that does not change tempo is byte-identical to one written before
 * this existed. `bpm` is kept in step, because it is what an older reader
 * will use.
 */
export function writeProjectTempoMap(project: ProjectFileData, map: TempoMap | null): void {
  if (!map || map.isConstant) {
    if (map) project.bpm = map.baseBpm;
    delete project.tempoChanges;
    return;
  }
  project.bpm = map.baseBpm;
  project.tempoChanges = map.changes.map((change) => ({
    atBeat: change.atBeat,
    bpm: change.bpm,
    ...(change.curve && change.curve !== 'jump' ? { curve: change.curve } : {}),
  }));
}

/** Parses `manifest.json` + `project.json`'s text content. Throws on malformed JSON, same as `JSON.parse` itself. */
export function parseProject(manifestJson: string, projectJson: string): ParsedProject {
  return {
    manifest: JSON.parse(manifestJson) as ProjectManifestData,
    project: JSON.parse(projectJson) as ProjectFileData,
  };
}

/**
 * A clip's `audioFileUri` is `file://Recordings/<projectId>/audio/<file>`,
 * the path as it exists inside the *running app's own* sandboxed container;
 * an exported bundle flattens that to just `audio/<file>` at its root. This
 * maps one to the other by keeping everything from the last `audio/` segment
 * onward, rather than assuming the exact `Recordings/<projectId>/` prefix.
 */
export function resolveAudioPath(uri: string): string {
  const marker = '/audio/';
  const idx = uri.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error(`resolveAudioPath: no "${marker}" segment in "${uri}"`);
  }
  return uri.slice(idx + 1);
}

/**
 * Reads whatever files a plugin's preset says it references, decodes them
 * per the plugin's declared `decode` kind, and stores each under the plugin's
 * own asset key.
 *
 * There used to be one of these per plugin, hand-written, in this file. There
 * is now one, and it does not know what a `.nam` file is. A plugin declares
 * its files through `assetRequests(preset)` and gets them back on the
 * AudioMaterial; crate's only opinion is where an archive keeps them
 * (`assets/<library>/<basename>`) and how to turn bytes into text or audio.
 *
 * A required asset missing from the export throws, same as a clip's missing
 * audio file: `readFile` means "decode everything real." An `optional: true`
 * request that is missing is skipped.
 */
async function hydratePluginAssets(
  material: AudioMaterial,
  requests: readonly AssetRequest[],
  readFile: (relativePath: string) => Promise<Uint8Array>,
): Promise<void> {
  for (const request of requests) {
    if (!request.filename) continue;
    let bytes: Uint8Array | null = null;
    let lastError: unknown = null;
    for (const library of [request.library, ...(request.fallbackLibraries ?? [])]) {
      try {
        bytes = await readFile(resolveProjectAssetPath(library, request.filename));
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!bytes) {
      if (request.optional) continue;
      throw lastError;
    }
    if (request.decode === 'text') {
      material.setAsset(request.key, {
        filename: request.filename,
        text: new TextDecoder().decode(bytes),
      } satisfies TextAssetData);
      continue;
    }
    const buffer = decodeAudioFile(bytes, request.filename);
    material.setAsset(request.key, {
      filename: request.filename,
      samples: buffer.getChannelData(0),
      samplesR: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : undefined,
      sampleRate: buffer.sampleRate,
    } satisfies AudioAssetData);
  }
}

function readCcLanes(payload: { [key: string]: unknown } | undefined): MidiCcLane[] {
  const raw = payload?.ccLanes;
  if (!Array.isArray(raw)) return [];
  const lanes: MidiCcLane[] = [];
  for (const lane of raw) {
    if (!lane || typeof lane !== 'object') continue;
    const rec = lane as { cc?: unknown; channel?: unknown; points?: unknown };
    if (typeof rec.cc !== 'number' || !Array.isArray(rec.points)) continue;
    const points = rec.points
      .filter((point): point is { startBeat: number; value: number } =>
        !!point &&
        typeof point === 'object' &&
        typeof (point as { startBeat?: unknown }).startBeat === 'number' &&
        typeof (point as { value?: unknown }).value === 'number',
      )
      .map((point) => ({ startBeat: point.startBeat, value: point.value }));
    lanes.push({
      cc: rec.cc,
      channel: typeof rec.channel === 'number' ? rec.channel : 0,
      points,
    });
  }
  return lanes;
}

export interface LoadProjectSceneOptions {
  /**
   * Reads one file's bytes given its path relative to the project bundle's
   * root (e.g. `"audio/track_0_....wav"`). Omit to build the scene without
   * decoding any audio. Every clip's
   * full metadata is still on `parsed.project.tracks[].clips`, just not
   * turned into a `Clip` with decoded sample data.
   */
  readFile?: (relativePath: string) => Promise<Uint8Array>;
  /** Injectable `AudioScene` factory, matching this package's usual DI pattern (`AudioContextLike`, `OfflineRenderer`). */
  createScene?: () => AudioScene;
  /**
   * Which AudioMaterial plugins this load knows about. Defaults to the shared
   * registry. A project referencing a plugin that is not registered keeps
   * every byte of that slot on `parsed.project`; it simply does not enter the
   * graph, which is the same treatment any unknown AUv3 has always had.
   */
  registry?: AudioMaterialRegistry;
}

/**
 * Builds an `AudioScene` from a parsed project: transport bpm/time
 * signature, the master bus's volume/mute, and one `Track` per real
 * project track (audio-bearing or instrument-hosting alike, since either
 * way it is a mixer channel with its own volume/pan/mute) with a
 * decoded `Clip` per audio-bearing clip when `readFile` is supplied.
 *
 * Plugin slots are mapped through the AudioMaterial registry: a slot whose native
 * plugin a registered `AudioMaterialPlugin` claims becomes that plugin's AudioMaterial,
 * with its preset params applied and, when `readFile` is supplied, every file
 * it declares hydrated onto the AudioMaterial. An `instrument`-role plugin lands on
 * `track.instrument`; an `insert` lands on the ordered `materials` chain.
 * Which plugins those are is the application's decision, not this loader's.
 * Still passthrough: unregistered plugins, automation lanes, key/scale,
 * section markers.
 * Clip trim, stretch, fades, and crossfade declarations map onto `Clip`.
 * `midiTracks` become `MidiClip`s on the instrument track (or the track
 * at `trackIndex` when there is no instrument id).
 */
export async function loadProjectScene(parsed: ParsedProject, options: LoadProjectSceneOptions = {}): Promise<AudioScene> {
  const scene = (options.createScene ?? (() => new AudioScene()))();
  const { project } = parsed;
  const registry = options.registry ?? audioMaterialRegistry;

  /**
   * One slot, whichever plugin owns it. Returns the AudioMaterial so the caller
   * can decide where it belongs (a bus has no `instrument` slot).
   *
   * Latency is read here, before hydration, on purpose: a plugin reports it
   * from the preset's *reference* to a file rather than from loaded bytes, so
   * PDC is correct in lightweight mode too. Same rule as the app's own
   * `hostedTrackLatencySamples`.
   */
  const bindSlot = async (
    slot: { plugin?: unknown; savedPresetData?: string | null } | null | undefined,
    trackIndex: number,
    slotIndex: number,
  ): Promise<{ material: AudioMaterial; role: 'insert' | 'instrument'; latency: number } | null> => {
    const mapped = mapPluginSlot(
      slot?.plugin as Parameters<typeof mapPluginSlot>[0],
      slot?.savedPresetData,
      registry,
    );
    if (!mapped.bound) return null;
    mapped.material.hostedSlot = { trackIndex, slotIndex };
    const latency = mapped.plugin.latencySamples?.(mapped.material) ?? 0;
    if (options.readFile && mapped.plugin.assetRequests) {
      await hydratePluginAssets(mapped.material, mapped.plugin.assetRequests(mapped.preset), options.readFile);
    }
    return { material: mapped.material, role: mapped.role, latency };
  };

  scene.transport.bpm = project.bpm;
  // A project with no changes leaves the transport with no map at all, so
  // every musical position resolves through the path it always did.
  const tempo = readProjectTempoMap(project);
  if (tempo.map) scene.transport.tempoMap = tempo.map;
  scene.transport.beatsPerBar = project.timeSigN;
  scene.transport.beatUnit = project.timeSigD > 0 ? project.timeSigD : 4;
  scene.master.volume = project.master.volume;
  scene.master.muted = project.master.muted;
  const masterSlots = listPluginSlots(project.master);
  for (let slotIndex = 0; slotIndex < masterSlots.length; slotIndex++) {
    const bound = await bindSlot(masterSlots[slotIndex], HOSTED_MASTER_TRACK_INDEX, slotIndex);
    // An instrument on the master bus doesn't fit anywhere (Bus has no
    // `instrument` slot, and a note-driven source on the master channel isn't
    // a configuration): left as passthrough on `parsed.project`, same as
    // any other unmodeled slot.
    if (!bound || bound.role !== 'insert') continue;
    scene.master.materials.add(bound.material);
    scene.master.latencySamples += bound.latency;
  }

  const trackById = new Map<string, Track>();
  const trackByIndex = new Map<number, Track>();

  for (const trackData of project.tracks) {
    const track = scene.addTrack(new Track({ name: `Track ${trackData.trackIndex + 1}` }));
    track.hostedTrackIndex = trackData.trackIndex;
    trackById.set(trackData.id, track);
    trackByIndex.set(trackData.trackIndex, track);
    track.pan = trackData.pan;
    track.volume = trackData.volume;
    track.muted = trackData.isMuted;

    const trackSlots = listPluginSlots(trackData);
    for (let slotIndex = 0; slotIndex < trackSlots.length; slotIndex++) {
      const bound = await bindSlot(trackSlots[slotIndex], trackData.trackIndex, slotIndex);
      if (!bound) continue;
      if (bound.role === 'instrument') {
        // A source voice, not an insert: it ignores `input` entirely, so
        // chaining it into `track.materials` (an ordered *effects* chain)
        // would be structurally wrong. See `Track.instrument`'s doc comment.
        track.instrument = bound.material;
      } else {
        track.materials.add(bound.material);
        track.latencySamples += bound.latency;
      }
    }

    for (const clipData of trackData.clips) {
      if (!options.readFile || !clipData.audioFileUri) continue;
      const path = resolveAudioPath(clipData.audioFileUri);
      const bytes = await options.readFile(path);
      const buffer = decodeAudioFile(bytes, path);
      const stretchRaw = clipData.stretchRatio;
      const clip = new Clip({
        buffer,
        name: typeof clipData.recordingName === 'string' ? clipData.recordingName : undefined,
        region: {
          trimStartSec: Math.max(0, (clipData.trimStartMs ?? 0) / 1000),
          trimEndSec: clipData.trimEndMs > clipData.trimStartMs ? clipData.trimEndMs / 1000 : null,
        },
        stretchRatio: typeof stretchRaw === 'number' && stretchRaw > 0 ? stretchRaw : 1,
        fadeInSec: Math.max(0, (clipData.fadeInMs ?? 0) / 1000),
        fadeOutSec: Math.max(0, (clipData.fadeOutMs ?? 0) / 1000),
        fadeInCurve: fadeCurveName(clipData.fadeInCurve, 'linear'),
        fadeOutCurve: fadeCurveName(clipData.fadeOutCurve, 'linear'),
        gainDb: typeof clipData.clipGainDb === 'number' ? clipData.clipGainDb : 0,
        crossfadeToNextSec: Math.max(0, (clipData.crossfadeToNextMs ?? 0) / 1000),
        crossfadeCurve: fadeCurveName(clipData.crossfadeCurve, 'equalPower'),
      });
      track.addClip(clip, { at: Time.seconds(clipData.offsetMs / 1000) });
    }
  }

  for (const midiTrack of project.midiTracks ?? []) {
    if (midiTrack.isMuted) continue;
    const dest =
      (midiTrack.instrumentTrackId ? trackById.get(midiTrack.instrumentTrackId) : undefined) ??
      trackByIndex.get(midiTrack.trackIndex);
    if (!dest || dest.muted) continue;
    for (const clipData of midiTrack.clips ?? []) {
      const rawNotes = clipData.payload?.notes ?? clipData.notes ?? [];
      const notes: MidiNote[] = rawNotes.map((note) => ({
        pitch: note.pitch,
        velocity: note.velocity,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        repeatCount: note.repeatCount,
        repeatSpacing: note.repeatSpacing,
        ccEvents: Array.isArray(note.ccEvents)
          ? note.ccEvents
              .filter((event): event is { cc: number; value: number } =>
                !!event && typeof event === 'object' && typeof (event as { cc?: unknown }).cc === 'number',
              )
              .map((event) => ({ cc: event.cc, value: event.value }))
          : undefined,
      }));
      dest.addMidiClip(
        new MidiClip({
          name: typeof clipData.id === 'string' ? clipData.id : undefined,
          notes,
          bars: clipData.payload?.bars,
          ccLanes: readCcLanes(clipData.payload),
        }),
        { at: Time.seconds((clipData.offsetMs ?? 0) / 1000) },
      );
    }
  }

  return scene;
}

export const ProjectLoader = {
  parse: parseProject,
  toScene: loadProjectScene,
  resolveAudioPath,
};
