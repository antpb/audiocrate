import {
  PROJECT_ARCHIVE_FORMAT_VERSION,
  PROJECT_ARCHIVE_KIND,
  createSamplePlayerMaterial,
  decodeAudioFile,
  irAsset,
  listPluginSlots,
  mapPluginSlot,
  parseProject,
  barBeats,
  TRANSPORT_KIND,
  resolveAudioPath,
  resolveProjectAssetPath,
  sampleAsset,
  type AssetRequest,
  type AudioAssetData,
  type AudioMaterial,
  type ProjectFileData,
  type ProjectMidiNoteData,
  type ProjectTrackData,
  type TextAssetData,
} from '../../src/index';
import {
  listZipEntries,
  normalizeZipName,
  readZipEntry,
  type ZipEntry,
} from './host/zipArchive';
import { AMP_ASSET, ampNamAsset, ampNamAssetR } from './host/ampAssets';
import { persistNodeAssets } from './assetStore';
import { catalogEntry } from './catalog';
import type { PatchEditor } from './editor';
import { applyIr, applyNam, applyNamR, applySample } from './nodeAssets';
import { KEYBOARD_KIND } from './analogKeyboard';
import { PATCH_KIND, PATCH_VERSION, type CratePatch, type PatchConnection, type PatchMidiNote, type PatchNode } from './patch';
import { LINE_KIND, MASTER_KIND, MIDICLIP_KIND } from './tools';

const COL = 220;
const ROW = 260;

export interface ImportedAsset {
  nodeId: string;
  kind: string;
  material: AudioMaterial;
}

export interface ImportedProject {
  patch: CratePatch;
  assets: ImportedAsset[];
  warnings: string[];
  name: string;
}

export function summarizeImportNotes(warnings: readonly string[]): string {
  const hw = new Map<string, number>();
  let missing = 0;
  const rest: string[] = [];
  for (const line of warnings) {
    if (line.startsWith('midi-hw:')) {
      const name = line.slice('midi-hw:'.length) || 'a hardware port';
      hw.set(name, (hw.get(name) ?? 0) + 1);
      continue;
    }
    if (line === 'midi-missing') {
      missing += 1;
      continue;
    }
    rest.push(line);
  }
  if (hw.size > 0) {
    const parts = [...hw.entries()].map(([name, count]) =>
      count === 1
        ? `1 MIDI clip stays on hardware port "${name}"`
        : `${count} MIDI clips stay on hardware port "${name}"`,
    );
    rest.push(`${parts.join('; ')}. Wire them to a synth if you want them on this graph.`);
  }
  if (missing > 0) {
    rest.push(
      missing === 1
        ? '1 MIDI clip has no mapped instrument yet.'
        : `${missing} MIDI clips have no mapped instrument yet.`,
    );
  }
  return rest.join(' ');
}

export function looksLikeZip(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip')) return true;
  return (
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    (file.type === 'application/octet-stream' && name.includes('.zip'))
  );
}

export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export async function importProjectBytes(bytes: Uint8Array): Promise<ImportedProject> {
  if (!isZipBytes(bytes)) {
    throw new Error('This file is not a readable zip archive.');
  }
  let entries: ZipEntry[];
  try {
    entries = listZipEntries(bytes);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(detail ? `This file is not a readable zip archive. (${detail})` : 'This file is not a readable zip archive.');
  }

  const byName = new Map<string, ZipEntry>();
  for (const entry of entries) {
    const path = normalizeZipName(entry.name);
    if (!path || path.endsWith('/') || path.includes('..')) continue;
    byName.set(path, entry);
  }

  const root = archiveRootFromNames([...byName.keys()]);
  const cache = new Map<string, Uint8Array>();
  const readFile = async (rel: string): Promise<Uint8Array | null> => {
    for (const name of [root + rel, rel]) {
      const cached = cache.get(name);
      if (cached) return cached;
      const entry = byName.get(name);
      if (!entry) continue;
      try {
        const out = await readZipEntry(bytes, entry);
        cache.set(name, out);
        await yieldToUi();
        return out;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(detail ? `This file is not a readable zip archive. (${detail})` : 'This file is not a readable zip archive.');
      }
    }
    return null;
  };

  const manifestJson = await readTextFile(readFile, 'manifest.json');
  const projectJson = await readTextFile(readFile, 'project.json');
  if (!manifestJson || !projectJson) {
    throw new Error('This zip is not a homecrate project archive.');
  }

  const parsed = parseProject(manifestJson, projectJson);
  if (parsed.manifest.kind !== PROJECT_ARCHIVE_KIND) {
    throw new Error('This zip is not a homecrate project archive.');
  }
  if (typeof parsed.manifest.formatVersion !== 'number' || parsed.manifest.formatVersion > PROJECT_ARCHIVE_FORMAT_VERSION) {
    throw new Error('This project was exported by a newer version of the app.');
  }
  if (!parsed.project || !Array.isArray(parsed.project.tracks)) {
    throw new Error('The archive contents could not be read.');
  }

  return buildImportedProject(parsed.project, parsed.manifest.projectName || parsed.project.name || 'Project', readFile);
}

export async function applyImportedAssets(editor: PatchEditor, imported: ImportedProject): Promise<void> {
  for (const item of imported.assets) {
    const dest = editor.materials.get(item.nodeId);
    if (!dest) continue;
    copyMaterialAssets(item.material, dest, item.kind);
    try {
      await persistNodeAssets(item.nodeId, dest, item.kind);
    } catch {
      imported.warnings.push(`Could not cache files for ${item.nodeId}. They are loaded for this session.`);
    }
  }
}

function archiveRootFromNames(names: string[]): string {
  const have = new Set(names);
  if (have.has('manifest.json') && have.has('project.json')) return '';
  for (const key of names) {
    if (!key.endsWith('manifest.json')) continue;
    const prefix = key.slice(0, -'manifest.json'.length);
    if (have.has(`${prefix}project.json`)) return prefix;
  }
  throw new Error('This zip is not a homecrate project archive.');
}

async function readTextFile(
  readFile: (rel: string) => Promise<Uint8Array | null>,
  rel: string,
): Promise<string | null> {
  const data = await readFile(rel);
  return data ? new TextDecoder().decode(data) : null;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function buildImportedProject(
  project: ProjectFileData,
  name: string,
  readFile: (rel: string) => Promise<Uint8Array | null>,
): Promise<ImportedProject> {
  const warnings: string[] = [];
  const nodes: PatchNode[] = [];
  const connections: PatchConnection[] = [];
  const assets: ImportedAsset[] = [];
  const used = new Set<string>();

  const addNode = (
    id: string,
    kind: string,
    x: number,
    y: number,
    params: Record<string, number> = {},
    data?: Record<string, unknown>,
  ): string => {
    let next = id;
    let n = 2;
    while (used.has(next)) {
      next = `${id}-${n}`;
      n += 1;
    }
    used.add(next);
    nodes.push({ id: next, kind, x, y, params, ...(data ? { data } : {}) });
    return next;
  };

  const cable = (source: string, sourceOutput: string, target: string, targetInput: string) => {
    connections.push({ source, sourceOutput, target, targetInput });
  };

  const keep = (nodeId: string, kind: string, material: AudioMaterial) => {
    assets.push({ nodeId, kind, material });
  };

  let keysId: string | null = null;
  let lineId: string | null = null;
  const ensureKeys = () => {
    if (!keysId) keysId = addNode('keys', KEYBOARD_KIND, 36, 40);
    return keysId;
  };
  const ensureLine = () => {
    if (!lineId) lineId = addNode('line', LINE_KIND, 36, 400, {}, { monitor: 0 });
    return lineId;
  };

  const mixTargets: string[] = [];
  const instByTrackId = new Map<string, string>();
  const instByIndex = new Map<number, string>();
  const eventStarts: number[] = [];
  const bpm = typeof project.bpm === 'number' && project.bpm > 0 ? project.bpm : 120;
  const beatsPerBar = typeof project.timeSigN === 'number' && project.timeSigN > 0 ? project.timeSigN : 4;
  const beatUnit = typeof project.timeSigD === 'number' && project.timeSigD > 0 ? project.timeSigD : 4;
  const tracks = [...project.tracks].sort((a, b) => a.trackIndex - b.trackIndex);
  let row = 0;

  for (const track of tracks) {
    const inserts = await bindSlots(track, readFile, warnings);
    const clips = await loadClips(track, readFile, warnings);
    const instrument = inserts.find((slot) => slot.role === 'instrument') ?? null;
    const effects = inserts.filter((slot) => slot.role === 'insert');
    if (clips.length === 0 && !instrument && effects.length === 0) continue;

    const y = 40 + row * ROW;
    row += 1;
    let col = 1;
    const sourceIds: string[] = [];

    if (instrument && catalogEntry(instrument.kind)) {
      const id = addNode(`t${track.trackIndex}-inst`, instrument.kind, 36 + col * COL, y, instrument.material.snapshotParams());
      keep(id, instrument.kind, instrument.material);
      cable(ensureKeys(), 'cv', id, 'note');
      cable(ensureKeys(), 'gate', id, 'gate');
      instByTrackId.set(track.id, id);
      instByIndex.set(track.trackIndex, id);
      sourceIds.push(id);
      col += 1;
    } else if (instrument) {
      warnings.push(`Skipped unknown instrument "${instrument.kind}" on track ${track.trackIndex + 1}.`);
    }

    for (const clip of clips) {
      const id = addNode(
        `t${track.trackIndex}-${clip.id}`,
        'sampleplayer',
        36 + col * COL,
        y + sourceIds.length * 56,
        clip.params,
        { clipOffsetSec: clip.offsetSec, clipDurationSec: clip.durationSec },
      );
      keep(id, 'sampleplayer', clip.material);
      sourceIds.push(id);
      eventStarts.push(clip.offsetSec);
    }
    if (clips.length) col += 1;

    if (sourceIds.length === 0 && effects.length > 0) {
      sourceIds.push(ensureLine());
    }

    let head = sourceIds[0] ?? null;
    const feed = (targetId: string, input = 'input') => {
      for (const source of sourceIds) cable(source, 'audio', targetId, input);
      sourceIds.length = 0;
      sourceIds.push(targetId);
      head = targetId;
    };

    for (const effect of effects) {
      if (!catalogEntry(effect.kind)) {
        warnings.push(`Skipped unknown insert "${effect.kind}" on track ${track.trackIndex + 1}.`);
        continue;
      }
      const id = addNode(`t${track.trackIndex}-${effect.kind}`, effect.kind, 36 + col * COL, y, effect.material.snapshotParams());
      keep(id, effect.kind, effect.material);
      if (sourceIds.length > 0) feed(id);
      else head = id;
      col += 1;
    }

    const muted = Boolean(track.isMuted || track.muted);
    const rawVolume = typeof track.volume === 'number' ? track.volume : 1;
    const volume = muted ? 0 : clamp(rawVolume, 0, 4);
    const pan = clamp(typeof track.pan === 'number' ? track.pan : 0, -1, 1);
    const gainId = addNode(`t${track.trackIndex}-gain`, 'gain', 36 + col * COL, y, { gain: volume });
    if (sourceIds.length > 0) feed(gainId);
    else if (head) cable(head, 'audio', gainId, 'input');
    col += 1;
    const panId = addNode(`t${track.trackIndex}-pan`, 'stereopan', 36 + col * COL, y, { pan });
    cable(gainId, 'audio', panId, 'input');
    mixTargets.push(panId);
  }

  attachMidiClips(project, addNode, cable, instByTrackId, instByIndex, eventStarts, warnings);

  const masterEffects = (await bindSlots(project.master ?? {}, readFile, warnings)).filter(
    (slot) => slot.role === 'insert',
  );
  let masterIn: string | null = null;
  let masterCol = 4;
  const masterY = Math.max(40, 40 + Math.max(0, row - 1) * ROW + (row > 0 ? 0 : 0));
  for (const effect of masterEffects) {
    if (!catalogEntry(effect.kind)) {
      warnings.push(`Skipped unknown master insert "${effect.kind}".`);
      continue;
    }
    const id = addNode(`master-${effect.kind}`, effect.kind, 36 + masterCol * COL, masterY, effect.material.snapshotParams());
    keep(id, effect.kind, effect.material);
    if (masterIn) cable(masterIn, 'audio', id, 'input');
    else for (const source of mixTargets) cable(source, 'audio', id, 'input');
    masterIn = id;
    masterCol += 1;
  }

  const masterVol = project.master?.muted ? 0 : clamp(typeof project.master?.volume === 'number' ? project.master.volume : 1, 0, 4);
  const masterGainId = addNode('master-gain', 'gain', 36 + masterCol * COL, masterY, { gain: masterVol });
  if (masterIn) cable(masterIn, 'audio', masterGainId, 'input');
  else for (const source of mixTargets) cable(source, 'audio', masterGainId, 'input');
  const masterId = addNode('master', MASTER_KIND, 36 + (masterCol + 1) * COL, masterY);
  cable(masterGainId, 'audio', masterId, 'input');

  const startSec = eventStarts.length > 0 ? Math.min(...eventStarts) : 0;
  if (startSec > 0.25) {
    const quarters = barBeats(beatsPerBar, beatUnit);
    const bar = quarters > 0 ? startSec * (bpm / 60) / quarters + 1 : 1;
    warnings.push(`Play starts at ${startSec.toFixed(1)}s (bar ${bar.toFixed(1)}), the first clip.`);
  }

  addNode('transport', TRANSPORT_KIND, 36, 40 - ROW, { bpm, beatsPerBar, beatUnit });

  return {
    patch: {
      version: PATCH_VERSION,
      kind: PATCH_KIND,
      nodes,
      connections,
      transport: { bpm, beatsPerBar, beatUnit, startSec },
    },
    assets,
    warnings: [summarizeImportNotes(warnings)].filter((line) => line.length > 0),
    name,
  };
}

async function bindSlots(
  container: { [key: string]: unknown },
  readFile: (rel: string) => Promise<Uint8Array | null>,
  warnings: string[],
): Promise<Array<{ kind: string; role: 'insert' | 'instrument'; material: AudioMaterial }>> {
  const bound: Array<{ kind: string; role: 'insert' | 'instrument'; material: AudioMaterial }> = [];
  for (const slot of listPluginSlots(container)) {
    const mapped = mapPluginSlot(slot?.plugin, slot?.savedPresetData);
    if (!mapped.bound) continue;
    if (mapped.plugin.assetRequests) {
      await hydratePluginAssets(mapped.material, mapped.plugin.assetRequests(mapped.preset), readFile, warnings);
    }
    bound.push({ kind: mapped.kind, role: mapped.role, material: mapped.material });
  }
  return bound;
}

function attachMidiClips(
  project: ProjectFileData,
  addNode: (
    id: string,
    kind: string,
    x: number,
    y: number,
    params?: Record<string, number>,
    data?: Record<string, unknown>,
  ) => string,
  cable: (source: string, sourceOutput: string, target: string, targetInput: string) => void,
  instByTrackId: Map<string, string>,
  instByIndex: Map<number, string>,
  eventStarts: number[],
  warnings: string[],
): void {
  for (const midiTrack of project.midiTracks ?? []) {
    if (midiTrack.isMuted) continue;
    const dest =
      (midiTrack.instrumentTrackId ? instByTrackId.get(midiTrack.instrumentTrackId) : undefined) ??
      instByIndex.get(midiTrack.trackIndex);
    if (!dest) {
      const destName = typeof midiTrack.destinationName === 'string' ? midiTrack.destinationName.trim() : '';
      if (destName) {
        warnings.push(`midi-hw:${destName}`);
      } else {
        warnings.push('midi-missing');
      }
    }
    let clipIndex = 0;
    for (const clip of midiTrack.clips ?? []) {
      const notes = readImportedMidiNotes(clip.payload?.notes ?? clip.notes ?? []);
      if (notes.length === 0) continue;
      const offsetSec = Math.max(0, (typeof clip.offsetMs === 'number' ? clip.offsetMs : 0) / 1000);
      eventStarts.push(offsetSec);
      const id = addNode(
        `midi-${midiTrack.trackIndex}-${clip.id ?? clipIndex}`,
        MIDICLIP_KIND,
        36,
        40 + (dest ? instByIndex.size : midiTrack.trackIndex) * 40 + clipIndex * 56,
        {},
        { notes, offsetSec, bars: clip.payload?.bars },
      );
      if (dest) {
        cable(id, 'cv', dest, 'note');
        cable(id, 'gate', dest, 'gate');
      }
      clipIndex += 1;
    }
  }
}

function readImportedMidiNotes(raw: ProjectMidiNoteData[]): PatchMidiNote[] {
  const notes: PatchMidiNote[] = [];
  for (const note of raw) {
    if (typeof note.pitch !== 'number' || typeof note.startBeat !== 'number' || typeof note.durationBeats !== 'number') {
      continue;
    }
    notes.push({
      pitch: note.pitch,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: typeof note.velocity === 'number' ? note.velocity : 0.85,
    });
  }
  return notes;
}

async function hydratePluginAssets(
  material: AudioMaterial,
  requests: readonly AssetRequest[],
  readFile: (rel: string) => Promise<Uint8Array | null>,
  warnings: string[],
): Promise<void> {
  for (const request of requests) {
    if (!request.filename) continue;
    let bytes: Uint8Array | null = null;
    for (const library of [request.library, ...(request.fallbackLibraries ?? [])]) {
      bytes = await readFile(resolveProjectAssetPath(library, request.filename));
      if (bytes) break;
    }
    if (!bytes) {
      if (!request.optional) warnings.push(`Missing ${request.filename}`);
      continue;
    }
    if (request.decode === 'text') {
      const text = new TextDecoder().decode(bytes);
      if (request.key === AMP_ASSET.nam || request.key === AMP_ASSET.namR) {
        material.setAsset(request.key, { filename: request.filename, json: text });
      } else {
        material.setAsset(request.key, { filename: request.filename, text } satisfies TextAssetData);
      }
      continue;
    }
    const audio = decodeAudioAsset(bytes, request.filename);
    if (!audio) {
      warnings.push(`Could not decode ${request.filename}`);
      continue;
    }
    material.setAsset(request.key, audio);
  }
}

async function loadClips(
  track: ProjectTrackData,
  readFile: (rel: string) => Promise<Uint8Array | null>,
  warnings: string[],
): Promise<Array<{ id: string; params: Record<string, number>; material: AudioMaterial; offsetSec: number; durationSec: number }>> {
  const clips: Array<{ id: string; params: Record<string, number>; material: AudioMaterial; offsetSec: number; durationSec: number }> = [];
  for (const clip of track.clips ?? []) {
    if (!clip.audioFileUri) continue;
    let path: string;
    try {
      path = resolveAudioPath(clip.audioFileUri);
    } catch {
      warnings.push(`Skipped a clip with an unreadable path on track ${track.trackIndex + 1}.`);
      continue;
    }
    const bytes = await readFile(path);
    if (!bytes) {
      warnings.push(`Missing ${path.replace(/^.*\//, '')}`);
      continue;
    }
    const audio = decodeAudioAsset(bytes, path.replace(/^.*\//, ''));
    await yieldToUi();
    if (!audio) {
      warnings.push(`Could not decode ${path.replace(/^.*\//, '')}`);
      continue;
    }
    const material = createSamplePlayerMaterial();
    applySample(material, audio);
    const durationSec = audio.samples.length / audio.sampleRate;
    const startSec = Math.max(0, (clip.trimStartMs ?? 0) / 1000);
    const start = durationSec > 0 ? clamp(startSec / durationSec, 0, 1) : 0;
    const stretch = typeof clip.stretchRatio === 'number' && clip.stretchRatio > 0 ? clip.stretchRatio : 1;
    const clipGain = typeof clip.clipGainDb === 'number' ? Math.pow(10, clip.clipGainDb / 20) : 1;
    material.setParam('loop', 0);
    material.setParam('start', start);
    material.setParam('rate', clamp(1 / stretch, 0.25, 4));
    material.setParam('gain', clamp(clipGain * 0.85, 0, 2));
    clips.push({
      id: typeof clip.id === 'string' && clip.id ? clip.id : `clip${clips.length}`,
      params: material.snapshotParams(),
      material,
      offsetSec: Math.max(0, (typeof clip.offsetMs === 'number' ? clip.offsetMs : 0) / 1000),
      durationSec: Math.max(0, (typeof clip.durationMs === 'number' ? clip.durationMs : 0) / 1000),
    });
  }
  return clips;
}

function decodeAudioAsset(bytes: Uint8Array, filename: string): AudioAssetData | null {
  try {
    const buffer = decodeAudioFile(bytes, filename);
    return {
      filename,
      samples: buffer.getChannelData(0).slice(),
      samplesR: buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : undefined,
      sampleRate: buffer.sampleRate,
    };
  } catch {
    return null;
  }
}

function copyMaterialAssets(from: AudioMaterial, to: AudioMaterial, kind: string): void {
  for (const key of from.assetKeys) {
    const value = from.getAsset(key);
    if (value !== undefined) to.setAsset(key, value);
  }
  if (kind === 'sampleplayer') {
    const sample = sampleAsset(from);
    if (sample) applySample(to, sample);
  }
  if (kind === 'amp') {
    const nam = ampNamAsset(from);
    if (nam) applyNam(to, nam);
    const namR = ampNamAssetR(from);
    if (namR) applyNamR(to, namR);
  }
  if (kind === 'ir') {
    const ir = irAsset(from);
    if (ir) applyIr(to, kind, ir);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
