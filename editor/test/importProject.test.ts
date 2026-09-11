import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { HAS_HOMECRATE } from './siblings';
import { registerHomecrateMaterials } from '../../examples/homecrate/src/index';
import { AU_TYPE_EFFECT, AU_TYPE_MUSIC_EFFECT } from '../../src/index';
import {
  HOMECRATE_AMP_MANUFACTURER,
  HOMECRATE_AMP_SUBTYPE,
  ampNamAsset,
  ampNamAssetR,
} from '../../examples/amp/src/index';
import { HOMECRATE_SYNTH_MANUFACTURER, HOMECRATE_SYNTH_SUBTYPE } from '../../examples/synth/src/index';
import { HOMECRATE_GRAIN_MANUFACTURER, HOMECRATE_GRAIN_SUBTYPE } from '../../examples/grain/src/index';
import { importProjectBytes, summarizeImportNotes } from '../src/importProject';

const MANIFEST = {
  kind: 'homecrate-project-archive',
  formatVersion: 1,
  appVersion: '0.0.1',
  exportedAt: '2026-09-05T18:03:29.289Z',
  projectId: 'proj-1',
  projectName: 'Test Song',
  counts: { audioFiles: 1, artworkFiles: 0, assetFiles: 0 },
};

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
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
  frames.forEach((sample, i) => data.writeFloatLE(sample, 8 + i * 4));

  const body = Buffer.concat([fmt, data]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return new Uint8Array(Buffer.concat([riff, body]));
}

function jsonBlob(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function namBytes(label: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ name: label }));
}

function projectZip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

function standardProject(overrides: Record<string, unknown> = {}) {
  return {
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
            recordingName: 'Take 1',
            offsetMs: 0,
            durationMs: 1000,
            trimStartMs: 0,
            trimEndMs: 1000,
            clipGainDb: -3,
          },
        ],
        volume: 0.75,
        pan: -0.2,
        isMuted: false,
      },
    ],
    midiTracks: [],
    master: { volume: 0.9, muted: false, pluginSlots: [] },
    ...overrides,
  };
}

describe('summarizeImportNotes', () => {
  it('collapses hardware MIDI warnings into one line', () => {
    expect(
      summarizeImportNotes([
        'midi-hw:H4MIDI-WC Port 1',
        'midi-hw:H4MIDI-WC Port 1',
        'midi-missing',
        'midi-missing',
        'Track 5 fader is at 0.',
      ]),
    ).toBe(
      'Track 5 fader is at 0. 2 MIDI clips stay on hardware port "H4MIDI-WC Port 1". Wire them to a synth if you want them on this graph. 2 MIDI clips have no mapped instrument yet.',
    );
  });
});

describe.skipIf(!HAS_HOMECRATE)('importProjectBytes', () => {
  registerHomecrateMaterials();
  it('builds a sample player graph from a homecrate project zip', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(standardProject()),
      'audio/take.wav': buildMinimalWav([0.5, 0.25, 0, -0.25]),
    });

    const imported = await importProjectBytes(zip);
    expect(imported.name).toBe('Test Song');
    const kinds = imported.patch.nodes.map((node) => node.kind);
    expect(kinds).toContain('sampleplayer');
    expect(kinds).toContain('gain');
    expect(kinds).toContain('stereopan');
    expect(kinds).toContain('master');
    expect(imported.patch.connections.some((conn) => conn.target === 'master')).toBe(true);
    expect(imported.assets.some((asset) => asset.kind === 'sampleplayer')).toBe(true);
    const pan = imported.patch.nodes.find((node) => node.kind === 'stereopan');
    expect(pan?.params.pan).toBeCloseTo(-0.2);
    expect(imported.patch.nodes.some((node) => node.kind === 'control')).toBe(false);
    expect(imported.patch.transport?.bpm).toBe(113);
    expect(imported.patch.transport?.beatsPerBar).toBe(4);
    expect(imported.patch.transport?.beatUnit).toBe(4);
    const clock = imported.patch.nodes.find((node) => node.kind === 'transport');
    expect(clock?.params).toEqual({ bpm: 113, beatsPerBar: 4, beatUnit: 4 });
    const player = imported.patch.nodes.find((node) => node.kind === 'sampleplayer');
    expect(player?.data?.clipOffsetSec).toBe(0);
    expect(player?.params.loop).toBe(0);
  });

  it('writes the project time signature onto the Transport node', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(standardProject({ bpm: 90, timeSigN: 6, timeSigD: 8 })),
      'audio/take.wav': buildMinimalWav([0.5, 0.25]),
    });
    const imported = await importProjectBytes(zip);
    expect(imported.patch.transport).toMatchObject({ bpm: 90, beatsPerBar: 6, beatUnit: 8 });
    expect(imported.patch.nodes.find((node) => node.kind === 'transport')?.params).toEqual({
      bpm: 90,
      beatsPerBar: 6,
      beatUnit: 8,
    });
  });

  it('reads isMuted and places MIDI clips on the instrument', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(
        standardProject({
          tracks: [
            {
              id: 'track-a',
              trackIndex: 0,
              clips: [],
              volume: 1,
              pan: 0,
              isMuted: false,
              pluginSlots: [
                {
                  plugin: {
                    componentType: 1635085685,
                    componentSubType: HOMECRATE_SYNTH_SUBTYPE,
                    componentManufacturer: HOMECRATE_SYNTH_MANUFACTURER,
                    componentName: 'hc_synth',
                  },
                  savedPresetData: null,
                },
              ],
            },
            {
              id: 'track-b',
              trackIndex: 1,
              clips: [
                {
                  id: 'clip-b',
                  audioFileUri: 'file://Recordings/proj-1/audio/take.wav',
                  offsetMs: 2000,
                  durationMs: 1000,
                  trimStartMs: 0,
                  trimEndMs: 1000,
                },
              ],
              volume: 0.5,
              pan: 0,
              isMuted: true,
            },
          ],
          midiTracks: [
            {
              trackIndex: 0,
              instrumentTrackId: 'track-a',
              isMuted: false,
              clips: [
                {
                  id: 'roll',
                  offsetMs: 2000,
                  payload: {
                    bars: 1,
                    notes: [{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
                  },
                },
              ],
            },
          ],
        }),
      ),
      'audio/take.wav': buildMinimalWav([0.5, 0.25]),
    });
    const imported = await importProjectBytes(zip);
    expect(imported.patch.nodes.some((node) => node.kind === 'midiclip')).toBe(true);
    expect(imported.patch.nodes.some((node) => node.kind === 'synth')).toBe(true);
    const mutedGain = imported.patch.nodes.find((node) => node.id === 't1-gain');
    expect(mutedGain?.params.gain).toBe(0);
    expect(imported.patch.transport?.startSec).toBeCloseTo(2);
    expect(imported.warnings.some((line) => /hardware|H4MIDI|no instrument/i.test(line))).toBe(false);
    expect(
      imported.patch.connections.some(
        (conn) => conn.source.startsWith('midi-') && conn.target.includes('inst') && conn.targetInput === 'note',
      ),
    ).toBe(true);
  });

  it('reads a Finder-wrapped archive root', async () => {
    const zip = projectZip({
      'Song/manifest.json': jsonBytes(MANIFEST),
      'Song/project.json': jsonBytes(standardProject()),
      'Song/audio/take.wav': buildMinimalWav([0.2, 0.1]),
    });
    const imported = await importProjectBytes(zip);
    expect(imported.assets).toHaveLength(1);
  });

  it('maps a registered insert onto the track chain', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(
        standardProject({
          tracks: [
            {
              id: 'track-a',
              trackIndex: 0,
              clips: [],
              volume: 1,
              pan: 0,
              isMuted: false,
              pluginSlots: [
                {
                  plugin: {
                    componentType: AU_TYPE_EFFECT,
                    componentSubType: HOMECRATE_AMP_SUBTYPE,
                    componentManufacturer: HOMECRATE_AMP_MANUFACTURER,
                    componentName: 'Amp',
                  },
                  savedPresetData: null,
                },
              ],
            },
          ],
        }),
      ),
    });
    const imported = await importProjectBytes(zip);
    expect(imported.patch.nodes.some((node) => node.kind === 'line')).toBe(true);
    expect(imported.patch.nodes.some((node) => node.kind === 'amp')).toBe(true);
    expect(imported.patch.connections.some((conn) => conn.source === 'line' && conn.target.includes('amp'))).toBe(true);
  });

  it('places Grain as a track insert instead of skipping it', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(
        standardProject({
          tracks: [
            {
              id: 'track-a',
              trackIndex: 0,
              clips: [
                {
                  id: 'clip-a',
                  audioFileUri: 'file://Recordings/proj-1/audio/take.wav',
                  offsetMs: 0,
                  durationMs: 1000,
                  trimStartMs: 0,
                  trimEndMs: 1000,
                },
              ],
              volume: 1,
              pan: 0,
              isMuted: false,
              pluginSlots: [
                {
                  plugin: {
                    componentType: AU_TYPE_EFFECT,
                    componentSubType: HOMECRATE_GRAIN_SUBTYPE,
                    componentManufacturer: HOMECRATE_GRAIN_MANUFACTURER,
                    componentName: 'Grain',
                  },
                  savedPresetData: null,
                },
              ],
            },
          ],
        }),
      ),
      'audio/take.wav': buildMinimalWav([0.5, 0.25]),
    });
    const imported = await importProjectBytes(zip);
    expect(imported.patch.nodes.some((node) => node.id === 't0-grain' && node.kind === 'grain')).toBe(true);
    expect(imported.patch.connections.some((conn) => conn.target === 't0-grain')).toBe(true);
    expect(imported.patch.connections.some((conn) => conn.source === 't0-grain' && conn.target === 't0-gain')).toBe(
      true,
    );
    expect(imported.warnings.join(' ')).not.toMatch(/Skipped Grain/i);
  });

  it('imports a stereo MIDI master Amp with both neural profiles', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(
        standardProject({
          master: {
            volume: 0.9,
            muted: false,
            pluginSlots: [
              {
                plugin: {
                  componentType: AU_TYPE_MUSIC_EFFECT,
                  componentSubType: HOMECRATE_AMP_SUBTYPE,
                  componentManufacturer: HOMECRATE_AMP_MANUFACTURER,
                  componentName: 'Amp',
                },
                savedPresetData: jsonBlob({
                  param_17: 1,
                  param_20: 0,
                  namFilename: 'left.nam',
                  namFilenameR: 'right.nam',
                }),
              },
            ],
          },
        }),
      ),
      'audio/take.wav': buildMinimalWav([0.2, 0.1]),
      'assets/NAM/left.nam': namBytes('left'),
      'assets/NAM/right.nam': namBytes('right'),
    });
    const imported = await importProjectBytes(zip);
    const amp = imported.patch.nodes.find((node) => node.id === 'master-amp');
    expect(amp?.kind).toBe('amp');
    expect(amp?.params.stereoMode).toBe(1);
    expect(imported.patch.connections.some((conn) => conn.target === 'master-amp')).toBe(true);
    expect(imported.patch.connections.some((conn) => conn.source === 'master-amp' && conn.target === 'master-gain')).toBe(
      true,
    );
    const asset = imported.assets.find((item) => item.nodeId === 'master-amp');
    expect(ampNamAsset(asset!.material)?.filename).toBe('left.nam');
    expect(ampNamAssetR(asset!.material)?.filename).toBe('right.nam');
    expect(imported.warnings.join(' ')).not.toMatch(/Skipped master Amp/i);
  });

  it('keeps MIDI clips that target a hardware port', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(
        standardProject({
          midiTracks: [
            {
              trackIndex: 4,
              instrumentTrackId: null,
              destinationName: 'HAMIDI-WC Port 1',
              isMuted: false,
              clips: [
                {
                  id: 'hw-roll',
                  offsetMs: 0,
                  payload: {
                    bars: 1,
                    notes: [{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
                  },
                },
              ],
            },
          ],
        }),
      ),
      'audio/take.wav': buildMinimalWav([0.2]),
    });
    const imported = await importProjectBytes(zip);
    expect(imported.patch.nodes.some((node) => node.id === 'midi-4-hw-roll' && node.kind === 'midiclip')).toBe(true);
    expect(imported.warnings.join(' ')).toMatch(/hardware port "HAMIDI-WC Port 1"/);
    expect(imported.warnings.join(' ')).not.toMatch(/not an instrument on the graph/);
  });

  it('warns when clip audio is missing instead of failing the import', async () => {
    const zip = projectZip({
      'manifest.json': jsonBytes(MANIFEST),
      'project.json': jsonBytes(standardProject()),
    });
    const imported = await importProjectBytes(zip);
    expect(imported.warnings.some((line) => /take\.wav/i.test(line))).toBe(true);
    expect(imported.patch.nodes.some((node) => node.kind === 'master')).toBe(true);
  });

  it('rejects a zip that is not a project archive', async () => {
    const zip = projectZip({ 'readme.txt': new TextEncoder().encode('hello') });
    await expect(importProjectBytes(zip)).rejects.toThrow(/homecrate project archive/);
  });
});
