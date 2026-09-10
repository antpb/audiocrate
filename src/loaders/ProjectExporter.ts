import { listPluginSlots, resolveProjectAssetPath } from '../host/pluginSlots';
import { mapPluginSlot } from '../host/mapPluginSlot';
import type { MaterialRegistry } from '../registry/MaterialRegistry';
import {
  resolveAudioPath,
  type ProjectFileData,
  type ProjectManifestData,
} from './ProjectLoader';

/**
 * The write half of `ProjectLoader`.
 * It writes the extracted archive directory (manifest.json + project.json +
 * audio/ + artwork/ + assets/), the same layout `parseProject` /
 * `loadProjectScene` read. Zip wrapping lives outside this package: crate
 * never imports a compressor, and the playground's `zip()` is a thin
 * virtual-FS wrapper around that directory.
 *
 * Archive contract:
 * - kind `homecrate-project-archive`, formatVersion 1
 * - drop `videoAttachment` / `sessionMirror`
 * - reset arm / monitor / editorVisible
 * - rewrite clip and artwork URIs to `file://Recordings/<id>/...`
 * - keep the source project id (import is what mints a new one)
 * - skip missing clips, list missing plugin assets
 */

export const PROJECT_ARCHIVE_KIND = 'homecrate-project-archive';
export const PROJECT_ARCHIVE_FORMAT_VERSION = 1;

export interface ExportProjectOptions {
  readFile: (path: string) => Promise<Uint8Array | null>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  appVersion?: string;
  exportedAt?: string;
  /**
   * Which Material plugins to consult when deciding what files a slot
   * references. Defaults to the shared registry. A plugin that is not
   * registered contributes no assets, and its slot is still copied verbatim
   * into the exported project.
   */
  registry?: MaterialRegistry;
}

export interface ExportProjectResult {
  manifest: ProjectManifestData;
  project: ProjectFileData;
  skippedClips: number;
  missingAssets: string[];
}

function baseName(path: string): string {
  return path.replace(/^.*[/\\]/, '');
}

function isSafeFileName(name: string): boolean {
  return !!name && !name.includes('/') && !name.includes('..') && name !== '.' ;
}

function resetRuntimeFields(project: ProjectFileData): void {
  delete project.videoAttachment;
  delete project.sessionMirror;
  for (const track of project.tracks ?? []) {
    track.isArmed = false;
    track.armState = 'off';
    track.monitorEnabled = false;
    for (const slot of listPluginSlots(track)) {
      if (slot) slot.editorVisible = false;
    }
  }
  for (const midi of project.midiTracks ?? []) {
    midi.armState = 'off';
    midi.monitorEnabled = false;
  }
  for (const slot of listPluginSlots(project.master ?? {})) {
    if (slot) slot.editorVisible = false;
  }
}

async function readFirst(
  readFile: (path: string) => Promise<Uint8Array | null>,
  candidates: string[],
): Promise<Uint8Array | null> {
  for (const path of candidates) {
    try {
      const bytes = await readFile(path);
      if (bytes && bytes.byteLength > 0) return bytes;
    } catch {
      // missing candidate
    }
  }
  return null;
}

type StagedAsset = { dest: string; kind: string; filename: string; candidates: string[] };

function collectPluginAssets(project: ProjectFileData, registry?: MaterialRegistry): StagedAsset[] {
  const seen = new Set<string>();
  const out: StagedAsset[] = [];
  const push = (dest: string, kind: string, filename: string, extra: string[]) => {
    if (!isSafeFileName(filename)) return;
    if (seen.has(dest)) return;
    seen.add(dest);
    out.push({ dest, kind, filename, candidates: [dest, ...extra, filename] });
  };

  const walk = (container: { [key: string]: unknown }) => {
    for (const slot of listPluginSlots(container)) {
      if (!slot?.plugin) continue;
      const mapped = mapPluginSlot(slot.plugin, slot.savedPresetData, registry);
      if (!mapped.bound || !mapped.plugin.assetRequests) continue;
      // The plugin says which files its preset references and which bucket
      // they belong in. The exporter's only job is to stage them, which is
      // why this loop no longer names a single plugin.
      for (const request of mapped.plugin.assetRequests(mapped.preset)) {
        if (!request.filename) continue;
        const filename = baseName(request.filename);
        const dest = resolveProjectAssetPath(request.library, filename);
        // Look in the app's own library folders too. A project saved without
        // ever re-exporting its assets references files that only exist under
        // HomecrateSamples, and dropping them would export a broken archive.
        const candidates = [request.library, ...(request.fallbackLibraries ?? [])].flatMap((library) => [
          resolveProjectAssetPath(library, filename),
          `HomecrateSamples/${library}/${filename}`,
        ]);
        push(dest, request.library, filename, candidates);
      }
    }
  };

  for (const track of project.tracks ?? []) walk(track);
  walk(project.master ?? {});
  return out;
}

/**
 * Writes one project's extracted archive next to `writeFile`. `readFile`
 * is asked for the live URI first, then the bundle-relative path, so the
 * same function works against a virtual FS, a test Map, or Documents.
 */
export async function exportProject(
  project: ProjectFileData,
  options: ExportProjectOptions,
): Promise<ExportProjectResult> {
  const copy = JSON.parse(JSON.stringify(project)) as ProjectFileData;
  resetRuntimeFields(copy);

  let skippedClips = 0;
  let audioFiles = 0;
  const stagedSources = new Map<string, string>();

  const stageAudio = async (uri: string): Promise<string | null> => {
    const candidates = [uri, uri.replace(/^file:\/\//, '')];
    try {
      candidates.push(resolveAudioPath(uri));
    } catch {
      // not an audio URI
    }
    const bytes = await readFirst(options.readFile, candidates);
    if (!bytes) return null;
    let name = baseName(uri);
    if (!isSafeFileName(name)) return null;
    const prior = stagedSources.get(name);
    if (prior && prior !== uri) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (stagedSources.has(`${stem}_${n}${ext}`)) n += 1;
      name = `${stem}_${n}${ext}`;
    }
    if (!stagedSources.has(name)) {
      await options.writeFile(`audio/${name}`, bytes);
      stagedSources.set(name, uri);
      audioFiles += 1;
    }
    return name;
  };

  for (const track of copy.tracks ?? []) {
    const kept: typeof track.clips = [];
    for (const clip of track.clips ?? []) {
      if (!clip.audioFileUri) {
        skippedClips += 1;
        continue;
      }
      const name = await stageAudio(clip.audioFileUri);
      if (!name) {
        skippedClips += 1;
        continue;
      }
      clip.audioFileUri = `file://Recordings/${copy.id}/audio/${name}`;
      if (typeof clip.monoAudioFileUri === 'string' && clip.monoAudioFileUri) {
        const monoName = await stageAudio(clip.monoAudioFileUri);
        clip.monoAudioFileUri = monoName
          ? `file://Recordings/${copy.id}/audio/${monoName}`
          : undefined;
      }
      kept.push(clip);
    }
    track.clips = kept;
  }

  let artworkFiles = 0;
  if (typeof copy.albumArtUri === 'string' && copy.albumArtUri) {
    const name = baseName(copy.albumArtUri);
    if (isSafeFileName(name)) {
      const bytes = await readFirst(options.readFile, [
        copy.albumArtUri,
        copy.albumArtUri.replace(/^file:\/\//, ''),
        `artwork/${name}`,
      ]);
      if (bytes) {
        await options.writeFile(`artwork/${name}`, bytes);
        copy.albumArtUri = `file://Recordings/${copy.id}/artwork/${name}`;
        artworkFiles += 1;
      } else {
        delete copy.albumArtUri;
      }
    } else {
      delete copy.albumArtUri;
    }
  }

  const missingAssets: string[] = [];
  let assetFiles = 0;
  for (const asset of collectPluginAssets(copy, options.registry)) {
    const bytes = await readFirst(options.readFile, asset.candidates);
    if (bytes) {
      await options.writeFile(asset.dest, bytes);
      assetFiles += 1;
    } else {
      missingAssets.push(`${asset.kind}/${asset.filename}`);
    }
  }

  const manifest: ProjectManifestData = {
    kind: PROJECT_ARCHIVE_KIND,
    formatVersion: PROJECT_ARCHIVE_FORMAT_VERSION,
    appVersion: options.appVersion ?? 'unknown',
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    projectId: copy.id,
    projectName: copy.name,
    counts: { audioFiles, artworkFiles, assetFiles },
  };

  const encoder = new TextEncoder();
  await options.writeFile('project.json', encoder.encode(JSON.stringify(copy)));
  await options.writeFile('manifest.json', encoder.encode(JSON.stringify(manifest, null, 2)));

  return { manifest, project: copy, skippedClips, missingAssets };
}

export const ProjectExporter = {
  export: exportProject,
};
