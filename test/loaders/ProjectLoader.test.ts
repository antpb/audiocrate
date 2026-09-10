import { describe, expect, it } from 'vitest';
import { loadProjectScene, parseProject, resolveAudioPath, type ParsedProject } from '../../src/loaders/ProjectLoader';
import { decodeWav } from '../../src/loaders/AudioLoader';
import { AudioScene } from '../../src/AudioScene';
import { AU_TYPE_EFFECT, AU_TYPE_INSTRUMENT } from '../../src/host/pluginSlots';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry';
import {
  FUZZ_ASSET_KEY,
  FUZZ_CURVE_LATENCY_SAMPLES,
  FUZZ_SUBTYPE,
  TEST_MANUFACTURER,
  TONE_SUBTYPE,
  fuzzPlugin,
  tonePlugin,
} from '../../src/testing/testPlugin';
import type { DecodedFuzzPreset } from '../../src/testing/testPlugin';
import type { AudioAssetData } from '../../src/graph/assets';

// Plugins crate does not ship, so nothing here can pass by accident on
// knowledge the loader secretly has about homecrate's own Materials.
const registry = new MaterialRegistry().registerAll([fuzzPlugin, tonePlugin]);
import { HOSTED_MASTER_TRACK_INDEX } from '../../src/automation/hosted';

function jsonBlob(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

const MANIFEST_JSON = JSON.stringify({
  kind: 'homecrate-project-archive',
  formatVersion: 1,
  appVersion: '0.0.1',
  exportedAt: '2026-09-05T18:03:29.289Z',
  projectId: 'proj-1',
  projectName: 'Test Song',
  counts: { audioFiles: 1, artworkFiles: 0, assetFiles: 0 },
});

const PROJECT_JSON = JSON.stringify({
  id: 'proj-1',
  name: 'Test Song',
  bpm: 113,
  timeSigN: 4,
  timeSigD: 4,
  tracks: [
    {
      id: 'track-a',
      trackIndex: 0,
      clips: [
        {
          id: 'clip-a',
          audioFileUri: 'file://Recordings/proj-1/audio/take.wav',
          monoAudioFileUri: 'file://Recordings/proj-1/audio/take_mono.wav',
          recordingName: 'Take 1',
          offsetMs: 2000,
          durationMs: 1000,
          trimStartMs: 0,
          trimEndMs: 1000,
          fadeInMs: 50,
          fadeOutMs: 80,
          fadeInCurve: 'equalPower',
          clipGainDb: -3,
          crossfadeToNextMs: 20,
        },
      ],
      volume: 0.75,
      pan: -0.2,
      isMuted: false,
      armState: 'off', // a field Crate doesn't model, preserved verbatim
    },
    {
      id: 'track-b',
      trackIndex: 1,
      clips: [],
      volume: 0.5,
      pan: 0,
      isMuted: true,
    },
  ],
  midiTracks: [
    {
      trackIndex: 0,
      instrumentTrackId: 'track-a',
      clips: [
        {
          id: 'midi-1',
          offsetMs: 500,
          payload: {
            bars: 2,
            notes: [{ pitch: 67, startBeat: 0, durationBeats: 1, velocity: 0.9 }],
          },
        },
      ],
    },
  ],
  master: { volume: 0.9, muted: false, pluginSlots: [] },
  keyRoot: 'C',
  keyScale: 'major',
});

function parseFixture(): ParsedProject {
  return parseProject(MANIFEST_JSON, PROJECT_JSON);
}

// A minimal valid float32 mono WAV, built the same way AudioLoader.test.ts does.
function buildMinimalWav(frames: number[]): Uint8Array {
  const dataBytes = frames.length * 4;
  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(3, 8); // IEEE float
  fmt.writeUInt16LE(1, 10); // mono
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

describe('parseProject', () => {
  it('parses manifest and project JSON, preserving fields Crate does not model', () => {
    const parsed = parseFixture();
    expect(parsed.manifest.projectName).toBe('Test Song');
    expect(parsed.project.bpm).toBe(113);
    expect(parsed.project.tracks[0]!.armState).toBe('off'); // untyped passthrough field, still present at runtime
    expect(parsed.project.keyRoot).toBe('C');
  });

  it('round-trips losslessly when nothing is mutated', () => {
    const parsed = parseFixture();
    expect(JSON.stringify(parsed.project)).toBe(PROJECT_JSON);
  });
});

describe('resolveAudioPath', () => {
  it('maps a sandboxed file:// URI to the exported bundle-relative path', () => {
    expect(resolveAudioPath('file://Recordings/abc-123/audio/take.wav')).toBe('audio/take.wav');
  });

  it('throws when there is no /audio/ segment', () => {
    expect(() => resolveAudioPath('file://Recordings/abc-123/artwork/cover.png')).toThrow();
  });
});

describe('loadProjectScene', () => {
  it('maps transport, master, and per-track volume/pan/mute onto a real AudioScene (lightweight mode: no readFile)', async () => {
    const parsed = parseFixture();
    const scene = await loadProjectScene(parsed);

    expect(scene.transport.bpm).toBe(113);
    expect(scene.transport.beatsPerBar).toBe(4);
    expect(scene.transport.beatUnit).toBe(4);
    expect(scene.master.volume).toBe(0.9);
    expect(scene.master.muted).toBe(false);

    expect(scene.tracks.length).toBe(2);
    expect(scene.tracks[0]!.volume).toBe(0.75);
    expect(scene.tracks[0]!.pan).toBe(-0.2);
    expect(scene.tracks[0]!.muted).toBe(false);
    expect(scene.tracks[1]!.muted).toBe(true);
  });

  it('creates no Clips in lightweight mode, but the raw clip data is still there', async () => {
    const parsed = parseFixture();
    const scene = await loadProjectScene(parsed);
    expect(scene.tracks[0]!.clips.length).toBe(0);
    expect(parsed.project.tracks[0]!.clips[0]!.durationMs).toBe(1000);
  });

  it('decodes real audio and builds Clips when readFile is provided (full-fidelity mode)', async () => {
    const parsed = parseFixture();
    const wavBytes = buildMinimalWav([0.1, 0.2, 0.3, 0.4]);
    const requestedPaths: string[] = [];

    const scene = await loadProjectScene(parsed, {
      readFile: async (path) => {
        requestedPaths.push(path);
        return wavBytes;
      },
    });

    expect(requestedPaths).toEqual(['audio/take.wav']); // resolved from the sandboxed file:// URI
    expect(scene.tracks[0]!.clips.length).toBe(1);
    const scheduled = scene.tracks[0]!.clips[0]!;
    expect(scheduled.clip.name).toBe('Take 1');
    expect(scheduled.clip.buffer.length).toBe(4);
    expect(Array.from(scheduled.clip.buffer.getChannelData(0))).toEqual([0.1, 0.2, 0.3, 0.4].map(Math.fround));
    // offsetMs: 2000 -> Time.seconds(2)
    expect(scheduled.at.toSeconds({ bpm: 120, ppqn: 24 })).toBe(2);
    expect(scheduled.clip.region.trimStartSec).toBe(0);
    expect(scheduled.clip.region.trimEndSec).toBe(1);
    expect(scheduled.clip.stretchRatio).toBe(1);
    expect(scheduled.clip.fadeInSec).toBeCloseTo(0.05);
    expect(scheduled.clip.fadeOutSec).toBeCloseTo(0.08);
    expect(scheduled.clip.fadeInCurve).toBe('equalPower');
    expect(scheduled.clip.gainDb).toBe(-3);
    expect(scheduled.clip.crossfadeToNextSec).toBeCloseTo(0.02);
    expect(scene.tracks[0]!.midiClips).toHaveLength(1);
    expect(scene.tracks[0]!.midiClips[0]!.at.toSeconds({ bpm: 120, ppqn: 24 })).toBeCloseTo(0.5);
    expect(scene.tracks[0]!.midiClips[0]!.clip.notes[0]!.pitch).toBe(67);
  });

  it('maps midiTracks onto the instrument track in lightweight mode', async () => {
    const parsed = parseFixture();
    const scene = await loadProjectScene(parsed);
    expect(scene.tracks[0]!.midiClips).toHaveLength(1);
    expect(scene.tracks[0]!.midiClips[0]!.clip.notes[0]).toMatchObject({
      pitch: 67,
      startBeat: 0,
      durationBeats: 1,
    });
  });

  it('routes an instrument-role plugin slot onto track.instrument, not the insert chain', async () => {
    const project = JSON.parse(PROJECT_JSON) as Record<string, unknown>;
    (project.tracks as Array<Record<string, unknown>>)[0]!.pluginSlots = [
      {
        plugin: {
          componentType: AU_TYPE_INSTRUMENT,
          componentSubType: TONE_SUBTYPE,
          componentManufacturer: TEST_MANUFACTURER,
        },
        savedPresetData: jsonBlob({}),
      },
    ];
    const parsed = parseProject(MANIFEST_JSON, JSON.stringify(project));
    const scene = await loadProjectScene(parsed, { registry });
    expect(scene.tracks[0]!.instrument).not.toBeNull();
    expect(scene.tracks[0]!.instrument!.kind).toBe('test.tone');
    expect(scene.tracks[0]!.materials.list).toHaveLength(0);
  });

  it('leaves an unregistered plugin slot out of the graph without losing it from the project', async () => {
    const project = JSON.parse(PROJECT_JSON) as Record<string, unknown>;
    (project.tracks as Array<Record<string, unknown>>)[0]!.pluginSlots = [
      {
        plugin: {
          componentType: AU_TYPE_EFFECT,
          componentSubType: 0x64726d73,
          componentManufacturer: 0x4f544852,
        },
        savedPresetData: jsonBlob({ param_0: 1 }),
      },
    ];
    const parsed = parseProject(MANIFEST_JSON, JSON.stringify(project));
    const scene = await loadProjectScene(parsed, { registry });
    expect(scene.tracks[0]!.materials.list).toHaveLength(0);
    expect(scene.tracks[0]!.instrument).toBeNull();
    // Still on the parsed project, byte for byte.
    expect((parsed.project.tracks[0] as unknown as Record<string, unknown>).pluginSlots).toBeDefined();
  });

  it('stamps hostedSlot/hostedTrackIndex so hosted automation can address live voices', async () => {
    const project = JSON.parse(PROJECT_JSON) as Record<string, unknown>;
    const tracks = project.tracks as Array<Record<string, unknown>>;
    // Two empty slots first: the stamped slotIndex must be the position in
    // the project's own sparse pluginSlots array, not a dense counter over
    // the slots crate happened to map.
    tracks[0]!.pluginSlots = [
      null,
      null,
      {
        plugin: {
          componentType: AU_TYPE_EFFECT,
          componentSubType: FUZZ_SUBTYPE,
          componentManufacturer: TEST_MANUFACTURER,
        },
        savedPresetData: jsonBlob({}),
      },
    ];
    (project.master as Record<string, unknown>).pluginSlots = [
      {
        plugin: {
          componentType: AU_TYPE_EFFECT,
          componentSubType: FUZZ_SUBTYPE,
          componentManufacturer: TEST_MANUFACTURER,
        },
        savedPresetData: jsonBlob({}),
      },
    ];

    const parsed = parseProject(MANIFEST_JSON, JSON.stringify(project));
    const scene = await loadProjectScene(parsed, { registry });

    expect(scene.tracks[0]!.hostedTrackIndex).toBe(0);
    expect(scene.tracks[1]!.hostedTrackIndex).toBe(1);
    expect(scene.tracks[0]!.materials.list[0]!.hostedSlot).toEqual({ trackIndex: 0, slotIndex: 2 });
    expect(scene.master.materials.list[0]!.hostedSlot).toEqual({
      trackIndex: HOSTED_MASTER_TRACK_INDEX,
      slotIndex: 0,
    });
  });

  it('takes per-track PDC latency from the plugin, even in lightweight mode', async () => {
    // Latency comes from the preset's *reference* to a file, not from loaded
    // bytes, so a project opened without readFile still schedules correctly.
    const project = JSON.parse(PROJECT_JSON) as Record<string, unknown>;
    const tracks = project.tracks as Array<Record<string, unknown>>;
    const fuzzSlot = (curveFilename?: string) => ({
      plugin: {
        componentType: AU_TYPE_EFFECT,
        componentSubType: FUZZ_SUBTYPE,
        componentManufacturer: TEST_MANUFACTURER,
      },
      savedPresetData: jsonBlob(curveFilename ? { curveFilename } : {}),
    });
    tracks[0]!.pluginSlots = [fuzzSlot('bright.wav')];
    tracks[1]!.pluginSlots = [fuzzSlot()];

    const parsed = parseProject(MANIFEST_JSON, JSON.stringify(project));
    const scene = await loadProjectScene(parsed, { registry }); // no readFile

    expect(scene.tracks[0]!.latencySamples).toBe(FUZZ_CURVE_LATENCY_SAMPLES);
    expect(scene.tracks[1]!.latencySamples).toBe(0);
  });

  it('hydrates whatever files a plugin declares, into the keys that plugin chose', async () => {
    const project = JSON.parse(PROJECT_JSON) as Record<string, unknown>;
    const tracks = project.tracks as Array<Record<string, unknown>>;
    tracks[0]!.pluginSlots = [
      {
        plugin: {
          componentType: AU_TYPE_EFFECT,
          componentSubType: FUZZ_SUBTYPE,
          componentManufacturer: TEST_MANUFACTURER,
        },
        savedPresetData: jsonBlob({ curveFilename: 'bright.wav' }),
      },
    ];

    const parsed = parseProject(MANIFEST_JSON, JSON.stringify(project));
    const requested: string[] = [];
    const scene = await loadProjectScene(parsed, {
      registry,
      readFile: async (path) => {
        requested.push(path);
        return buildMinimalWav([0.5, -0.5]);
      },
    });

    // The bucket comes from the plugin's AssetRequest, not from a table in
    // the loader.
    expect(requested).toContain('assets/Curves/bright.wav');
    const material = scene.tracks[0]!.materials.list[0]!;
    const curve = material.getAsset<AudioAssetData>(FUZZ_ASSET_KEY);
    expect(curve?.filename).toBe('bright.wav');
    expect(Array.from(curve!.samples)).toEqual([0.5, -0.5]);
    expect(curve!.samplesR).toBeUndefined(); // mono fixture
  });

  it('tries a plugin\'s fallback libraries before giving up on an asset', async () => {
    // Real archives drift: the same file has shipped under more than one
    // folder name depending on the version that wrote it.
    const project = JSON.parse(PROJECT_JSON) as Record<string, unknown>;
    const tracks = project.tracks as Array<Record<string, unknown>>;
    const withFallback = new MaterialRegistry().register({
      ...fuzzPlugin,
      assetRequests: (preset: DecodedFuzzPreset) =>
        preset.curveFilename
          ? [
              {
                key: FUZZ_ASSET_KEY,
                library: 'Curves',
                fallbackLibraries: ['Legacy'],
                filename: preset.curveFilename,
                decode: 'audio' as const,
              },
            ]
          : [],
    });
    tracks[0]!.pluginSlots = [
      {
        plugin: {
          componentType: AU_TYPE_EFFECT,
          componentSubType: FUZZ_SUBTYPE,
          componentManufacturer: TEST_MANUFACTURER,
        },
        savedPresetData: jsonBlob({ curveFilename: 'old.wav' }),
      },
    ];

    const parsed = parseProject(MANIFEST_JSON, JSON.stringify(project));
    const requested: string[] = [];
    const scene = await loadProjectScene(parsed, {
      registry: withFallback,
      readFile: async (path) => {
        requested.push(path);
        if (path === 'assets/Curves/old.wav') throw new Error('ENOENT');
        return buildMinimalWav([1]);
      },
    });

    expect(requested.filter((path) => path.startsWith('assets/'))).toEqual([
      'assets/Curves/old.wav',
      'assets/Legacy/old.wav',
    ]);
    expect(scene.tracks[0]!.materials.list[0]!.hasAsset(FUZZ_ASSET_KEY)).toBe(true);
  });

  it('loads payload.ccLanes onto the MidiClip', async () => {
    const project = JSON.parse(PROJECT_JSON) as Record<string, unknown>;
    const midiTracks = project.midiTracks as Array<Record<string, unknown>>;
    const clip = (midiTracks[0]!.clips as Array<Record<string, unknown>>)[0]!;
    const payload = clip.payload as Record<string, unknown>;
    payload.ccLanes = [{ cc: 1, channel: 0, points: [{ startBeat: 0.5, value: 90 }] }];
    const parsed = parseProject(MANIFEST_JSON, JSON.stringify(project));
    const scene = await loadProjectScene(parsed);
    expect(scene.tracks[0]!.midiClips[0]!.clip.ccLanes).toEqual([
      { cc: 1, channel: 0, points: [{ startBeat: 0.5, value: 90 }] },
    ]);
  });

  it('supports an injected createScene, matching this package\'s usual DI pattern', async () => {
    const parsed = parseFixture();
    let created = 0;
    await loadProjectScene(parsed, {
      createScene: () => {
        created += 1;
        return new AudioScene();
      },
    });
    expect(created).toBe(1);
  });
});

describe('decodeWav sanity check reused from AudioLoader (guards against fixture drift)', () => {
  it('the minimal WAV builder used above actually decodes', () => {
    const buffer = decodeWav(buildMinimalWav([1, -1]));
    expect(buffer.numberOfChannels).toBe(1);
    expect(Array.from(buffer.getChannelData(0))).toEqual([1, -1]);
  });
});
