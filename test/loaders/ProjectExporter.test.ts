import { describe, expect, it } from 'vitest';
import { exportProject } from '../../src/loaders/ProjectExporter';
import { loadProjectScene, parseProject, type ProjectFileData } from '../../src/loaders/ProjectLoader';
import { AU_TYPE_EFFECT } from '../../src/host/pluginSlots';
import { AudioMaterialRegistry } from '../../src/registry/AudioMaterialRegistry';
import { FUZZ_ASSET_KEY, FUZZ_SUBTYPE, TEST_MANUFACTURER, fuzzPlugin } from '../../src/testing/testPlugin';
import type { AudioAssetData } from '../../src/graph/assets';

/**
 * A second plugin whose file lives in a differently-named bucket, so the
 * export path is exercised against two plugins rather than one. Neither is a
 * plugin crate ships: the exporter must learn what to stage from the registry.
 */
const inkPlugin = {
  ...fuzzPlugin,
  kind: 'test.ink',
  create: () => {
    const material = fuzzPlugin.create();
    return Object.assign(material, { kind: 'test.ink' });
  },
  host: {
    componentType: AU_TYPE_EFFECT,
    componentSubType: 0x696e6b20,
    componentManufacturer: TEST_MANUFACTURER,
  },
  assetRequests: (preset: { curveFilename?: string }) =>
    preset.curveFilename
      ? [{ key: 'ink.loop', library: 'samples', filename: preset.curveFilename, decode: 'audio' as const }]
      : [],
};

const registry = new AudioMaterialRegistry().registerAll([fuzzPlugin, inkPlugin]);

function jsonBlob(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function buildMinimalWav(frames: number[]): Uint8Array {
  const dataBytes = frames.length * 4;
  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(3, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(44100, 12);
  fmt.writeUInt32LE(44100 * 4, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(32, 22);

  const data = Buffer.alloc(8 + dataBytes);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(dataBytes, 4);
  frames.forEach((s, i) => data.writeFloatLE(s, 8 + i * 4));

  const body = Buffer.concat([fmt, data]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return new Uint8Array(Buffer.concat([riff, body]));
}

function sourceProject(): ProjectFileData {
  return {
    id: 'proj-1',
    name: 'Export Song',
    bpm: 94,
    timeSigN: 7,
    timeSigD: 8,
    tracks: [
      {
        id: 'track-a',
        trackIndex: 0,
        clips: [
          {
            id: 'clip-a',
            audioFileUri: 'file://Recordings/proj-1/audio/take.wav',
            recordingName: 'Take 1',
            offsetMs: 0,
            durationMs: 1000,
            trimStartMs: 0,
            trimEndMs: 1000,
          },
          {
            id: 'clip-missing',
            audioFileUri: 'file://Recordings/proj-1/audio/gone.wav',
            offsetMs: 1000,
            durationMs: 500,
            trimStartMs: 0,
            trimEndMs: 500,
          },
        ],
        volume: 1,
        pan: 0,
        isMuted: false,
        isArmed: true,
        armState: 'record',
        monitorEnabled: true,
        pluginSlots: [
          {
            plugin: {
              componentType: AU_TYPE_EFFECT,
              componentSubType: FUZZ_SUBTYPE,
              componentManufacturer: TEST_MANUFACTURER,
            },
            savedPresetData: jsonBlob({ curveFilename: 'bright.wav' }),
            editorVisible: true,
          },
          {
            plugin: {
              componentType: AU_TYPE_EFFECT,
              componentSubType: 0x696e6b20,
              componentManufacturer: TEST_MANUFACTURER,
            },
            savedPresetData: jsonBlob({ curveFilename: 'loop.wav' }),
          },
        ],
      },
    ],
    midiTracks: [{ trackIndex: 0, instrumentTrackId: 'track-a', clips: [], armState: 'record', monitorEnabled: true }],
    master: { volume: 1, muted: false, pluginSlots: [] },
    videoAttachment: { uri: 'file://Recordings/proj-1/video.mov' },
    sessionMirror: { foo: 1 },
    albumArtUri: 'file://Recordings/proj-1/artwork/cover.png',
  };
}

describe('exportProject', () => {
  it('writes a homecrate archive directory that parseProject + loadProjectScene can reopen', async () => {
    const wav = buildMinimalWav([0.1, 0.2]);
    const cover = new Uint8Array([1, 2, 3]);
    const sources = new Map<string, Uint8Array>([
      ['file://Recordings/proj-1/audio/take.wav', wav],
      ['assets/Curves/bright.wav', wav],
      ['assets/samples/loop.wav', wav],
      ['file://Recordings/proj-1/artwork/cover.png', cover],
    ]);
    const written = new Map<string, Uint8Array>();

    const result = await exportProject(sourceProject(), {
      registry,
      appVersion: '0.0.1',
      exportedAt: '2026-09-05T18:00:00.000Z',
      readFile: async (path) => sources.get(path) ?? null,
      writeFile: async (path, bytes) => {
        written.set(path, bytes);
      },
    });

    expect(result.skippedClips).toBe(1);
    expect(result.missingAssets).toEqual([]);
    expect(result.manifest).toMatchObject({
      kind: 'homecrate-project-archive',
      formatVersion: 1,
      appVersion: '0.0.1',
      projectId: 'proj-1',
      projectName: 'Export Song',
      counts: { audioFiles: 1, artworkFiles: 1, assetFiles: 2 },
    });
    expect(result.project.videoAttachment).toBeUndefined();
    expect(result.project.sessionMirror).toBeUndefined();
    expect(result.project.tracks[0]!.isArmed).toBe(false);
    expect(result.project.tracks[0]!.armState).toBe('off');
    expect(result.project.tracks[0]!.monitorEnabled).toBe(false);
    expect((result.project.tracks[0]!.pluginSlots as Record<string, unknown>[] | undefined)?.[0]).toMatchObject({
      editorVisible: false,
    });
    expect(result.project.midiTracks[0]!.armState).toBe('off');
    expect(result.project.tracks[0]!.clips).toHaveLength(1);
    expect(result.project.tracks[0]!.clips[0]!.audioFileUri).toBe(
      'file://Recordings/proj-1/audio/take.wav',
    );
    expect(result.project.albumArtUri).toBe('file://Recordings/proj-1/artwork/cover.png');

    expect(written.has('manifest.json')).toBe(true);
    expect(written.has('project.json')).toBe(true);
    expect(written.get('audio/take.wav')).toEqual(wav);
    expect(written.get('assets/Curves/bright.wav')).toEqual(wav);
    expect(written.get('assets/samples/loop.wav')).toEqual(wav);
    expect(written.get('artwork/cover.png')).toEqual(cover);

    const parsed = parseProject(
      new TextDecoder().decode(written.get('manifest.json')),
      new TextDecoder().decode(written.get('project.json')),
    );
    expect(parsed.project.id).toBe('proj-1');
    expect(parsed.project.bpm).toBe(94);
    expect(parsed.project.timeSigN).toBe(7);
    expect(parsed.project.timeSigD).toBe(8);

    const scene = await loadProjectScene(parsed, {
      registry,
      readFile: async (path) => {
        const bytes = written.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      },
    });
    expect(scene.tracks[0]!.clips).toHaveLength(1);
    expect(scene.transport.bpm).toBe(94);
    expect(scene.transport.beatsPerBar).toBe(7);
    expect(scene.transport.beatUnit).toBe(8);
    expect(
      scene.tracks[0]!.materials.list[0]!.getAsset<AudioAssetData>(FUZZ_ASSET_KEY)?.filename,
    ).toBe('bright.wav');
  });

  it('lists plugin files that readFile cannot find', async () => {
    const wav = buildMinimalWav([0.25]);
    const result = await exportProject(sourceProject(), {
      registry,
      readFile: async (path) => (path.includes('take.wav') ? wav : null),
      writeFile: async () => {},
    });
    expect(result.skippedClips).toBe(1);
    expect(result.missingAssets).toEqual(['Curves/bright.wav', 'samples/loop.wav']);
    expect(result.manifest.counts.assetFiles).toBe(0);
  });
});
