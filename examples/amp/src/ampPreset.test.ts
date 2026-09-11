import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  applyAmpPreset,
  decodeAmpPreset,
  HOMECRATE_AMP_MANUFACTURER,
  HOMECRATE_AMP_SUBTYPE,
  isHomecrateAmp,
} from './ampPreset';
import { AU_TYPE_EFFECT, AudioMaterialRegistry, loadProjectScene, parseProject, resolveProjectAssetPath } from './crate';
import { createAmpMaterial } from './ampMaterial';
import { ampNamAsset, ampIrAsset } from './assets';
import { ampPlugin } from './plugin';

// Registering explicitly is the whole point: crate has no built-in knowledge
// of this plugin, so a load that does not register it finds nothing.
const registry = new AudioMaterialRegistry().register(ampPlugin);

function jsonBlob(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

describe('amp preset + slot mapping', () => {
  it('decodes a JSON fallback blob onto amp params and filenames', () => {
    const decoded = decodeAmpPreset(
      jsonBlob({
        param_0: 1.5,
        param_9: 0.4,
        param_27: 0.25,
        namFilename: 'red_face_75_4vol_a2full.nam',
        irFilename: 'cab.wav',
        namFilenameR: '',
      }),
    );
    expect(decoded.params.inputGain).toBeCloseTo(1.5);
    expect(decoded.params.reverbBlend).toBeCloseTo(0.4);
    expect(decoded.params.delayMix).toBeCloseTo(0.25);
    expect(decoded.namFilename).toBe('red_face_75_4vol_a2full.nam');
    expect(decoded.irFilename).toBe('cab.wav');
    expect(decoded.namFilenameR).toBeUndefined();
  });

  it('decodes an NSKeyedArchiver bplist blob', () => {
    const py = `
import io, plistlib, base64
objects = [
    "$null",
    {"$class": plistlib.UID(2), "NS.keys": [plistlib.UID(3), plistlib.UID(5), plistlib.UID(7)], "NS.objects": [plistlib.UID(4), plistlib.UID(6), plistlib.UID(8)]},
    {"$classname": "NSDictionary", "$classes": ["NSDictionary", "NSObject"]},
    "param_1",
    2.0,
    "namFilename",
    "factory.nam",
    "irFilename",
    "room.wav",
]
root = {"$archiver": "NSKeyedArchiver", "$version": 100000, "$objects": objects, "$top": {"root": plistlib.UID(1)}}
buf = io.BytesIO()
plistlib.dump(root, buf, fmt=plistlib.FMT_BINARY)
print(base64.b64encode(buf.getvalue()).decode(), end="")
`;
    const blob = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
    const decoded = decodeAmpPreset(blob);
    expect(decoded.params.outputGain).toBeCloseTo(2);
    expect(decoded.namFilename).toBe('factory.nam');
    expect(decoded.irFilename).toBe('room.wav');
  });

  it('unwraps NS.string objects for namFilename', () => {
    const decoded = decodeAmpPreset(
      jsonBlob({
        namFilename: { 'NS.string': 'wrapped.nam' },
        irFilename: { 'NS.string': 'cab.wav' },
      }),
    );
    expect(decoded.namFilename).toBe('wrapped.nam');
    expect(decoded.irFilename).toBe('cab.wav');
  });

  it('unwraps NSString objects inside an NSKeyedArchiver blob', () => {
    const py = `
import io, plistlib, base64
objects = [
    "$null",
    {"$class": plistlib.UID(2), "NS.keys": [plistlib.UID(3), plistlib.UID(5)], "NS.objects": [plistlib.UID(4), plistlib.UID(6)]},
    {"$classname": "NSDictionary", "$classes": ["NSDictionary", "NSObject"]},
    "namFilename",
    {"$class": plistlib.UID(8), "NS.string": plistlib.UID(7)},
    "param_1",
    1.25,
    "wrapped.nam",
    {"$classname": "NSString", "$classes": ["NSString", "NSObject"]},
]
root = {"$archiver": "NSKeyedArchiver", "$version": 100000, "$objects": objects, "$top": {"root": plistlib.UID(1)}}
buf = io.BytesIO()
plistlib.dump(root, buf, fmt=plistlib.FMT_BINARY)
print(base64.b64encode(buf.getvalue()).decode(), end="")
`;
    const blob = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
    const decoded = decodeAmpPreset(blob);
    expect(decoded.namFilename).toBe('wrapped.nam');
    expect(decoded.params.outputGain).toBeCloseTo(1.25);
  });

  it('keeps namFilename when the archive also contains NSData (marker 0x4f)', () => {
    const py = `
import io, plistlib, base64
payload = bytes(range(20))
objects = [
    "$null",
    {"$class": plistlib.UID(2), "NS.keys": [plistlib.UID(3), plistlib.UID(5), plistlib.UID(7), plistlib.UID(9)], "NS.objects": [plistlib.UID(4), plistlib.UID(6), plistlib.UID(8), plistlib.UID(10)]},
    {"$classname": "NSDictionary", "$classes": ["NSDictionary", "NSObject"]},
    "namFilename",
    "real.nam",
    "param_1",
    1.5,
    "data",
    payload,
    "irFilename",
    "cab.wav",
]
root = {"$archiver": "NSKeyedArchiver", "$version": 100000, "$objects": objects, "$top": {"root": plistlib.UID(1)}}
buf = io.BytesIO()
plistlib.dump(root, buf, fmt=plistlib.FMT_BINARY)
raw = buf.getvalue()
if 0x4f not in raw:
    raise SystemExit("expected bplist data marker 0x4f")
print(base64.b64encode(raw).decode(), end="")
`;
    const blob = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
    const decoded = decodeAmpPreset(blob);
    expect(decoded.namFilename).toBe('real.nam');
    expect(decoded.irFilename).toBe('cab.wav');
    expect(decoded.params.outputGain).toBeCloseTo(1.5);
  });

  it('decodes a real Foundation NSKeyedArchiver fullState blob', () => {
    const swift = `
import Foundation
var big = Data(count: 256)
for i in 0..<256 { big[i] = UInt8(i) }
let state: [String: Any] = [
  "namFilename": "twin_reverb.nam",
  "irFilename": "2x12.wav",
  "param_0": 1.25,
  "param_1": 0.8,
  "data": big,
]
let data = try NSKeyedArchiver.archivedData(withRootObject: state, requiringSecureCoding: false)
print(data.base64EncodedString(), terminator: "")
`;
    const blob = execFileSync('swift', ['-e', swift], { encoding: 'utf8' });
    const decoded = decodeAmpPreset(blob);
    expect(decoded.namFilename).toBe('twin_reverb.nam');
    expect(decoded.irFilename).toBe('2x12.wav');
    expect(decoded.params.inputGain).toBeCloseTo(1.25);
    expect(decoded.params.outputGain).toBeCloseTo(0.8);
  });

  it('isHomecrateAmp matches namg and applyAmpPreset writes the material', () => {
    expect(isHomecrateAmp({ componentType: 0, componentSubType: HOMECRATE_AMP_SUBTYPE, componentManufacturer: 0 })).toBe(
      true,
    );
    expect(isHomecrateAmp({ componentType: 0, componentSubType: 1, componentManufacturer: 0 })).toBe(false);
    const material = createAmpMaterial();
    applyAmpPreset(material, decodeAmpPreset(jsonBlob({ param_27: 0.5 })));
    expect(material.getParam('delayMix')).toBeCloseTo(0.5);
    expect(resolveProjectAssetPath('NAM', 'foo/bar.nam')).toBe('assets/NAM/bar.nam');
  });

  it('loadProjectScene attaches ampMaterial for a namg slot', async () => {
    const blob = jsonBlob({ param_0: 0.8, param_9: 0.3, namFilename: 'a2.nam' });
    const parsed = parseProject(
      JSON.stringify({
        kind: 'homecrate-project-archive',
        formatVersion: 1,
        appVersion: '0.0.1',
        exportedAt: '2026-09-05T00:00:00.000Z',
        projectId: 'p',
        projectName: 'Amp Song',
        counts: { audioFiles: 0, artworkFiles: 0, assetFiles: 0 },
      }),
      JSON.stringify({
        id: 'p',
        name: 'Amp Song',
        bpm: 120,
        timeSigN: 4,
        timeSigD: 4,
        tracks: [
          {
            id: 't0',
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
                  componentName: 'homecrate: hc_amp',
                },
                savedPresetData: blob,
                routeClipsToInput: false,
              },
              null,
            ],
          },
        ],
        midiTracks: [],
        master: { volume: 1, muted: false, pluginSlots: [] },
      }),
    );
    const scene = await loadProjectScene(parsed, { registry });
    const materials = scene.tracks[0]!.materials.list;
    expect(materials).toHaveLength(1);
    expect(materials[0]!.name).toBe('Amp');
    expect(materials[0]!.getParam('inputGain')).toBeCloseTo(0.8);
    expect(materials[0]!.getParam('reverbBlend')).toBeCloseTo(0.3);
  });

  it('hydrates the profile and cabinet bytes onto the AudioMaterial when readFile is supplied', async () => {
    const blob = jsonBlob({ namFilename: 'a2.nam', irFilename: 'cab.wav' });
    const parsed = parseProject(
      JSON.stringify({
        kind: 'homecrate-project-archive',
        formatVersion: 1,
        appVersion: '0.0.1',
        exportedAt: '2026-09-05T00:00:00.000Z',
        projectId: 'p',
        projectName: 'Amp Song',
        counts: { audioFiles: 0, artworkFiles: 0, assetFiles: 1 },
      }),
      JSON.stringify({
        id: 'p',
        name: 'Amp Song',
        bpm: 120,
        timeSigN: 4,
        timeSigD: 4,
        tracks: [],
        midiTracks: [],
        master: {
          volume: 1,
          muted: false,
          pluginSlots: [
            {
              plugin: {
                componentType: AU_TYPE_EFFECT,
                componentSubType: HOMECRATE_AMP_SUBTYPE,
                componentManufacturer: HOMECRATE_AMP_MANUFACTURER,
                componentName: 'homecrate: hc_amp',
              },
              savedPresetData: blob,
            },
          ],
        },
      }),
    );

    const namJson = JSON.stringify({ architecture: 'fake' });
    const requested: string[] = [];
    const scene = await loadProjectScene(parsed, {
      registry,
      readFile: async (path) => {
        requested.push(path);
        if (path === 'assets/NAM/a2.nam') return new TextEncoder().encode(namJson);
        if (path === 'assets/IR/cab.wav') return buildMonoFloatWav([0.25, -0.25, 0.5]);
        throw new Error(`unexpected readFile path: ${path}`);
      },
    });

    expect(requested.sort()).toEqual(['assets/IR/cab.wav', 'assets/NAM/a2.nam']);
    const material = scene.master.materials.list[0]!;
    expect(ampNamAsset(material)).toEqual({ filename: 'a2.nam', json: namJson });
    expect(ampIrAsset(material)?.filename).toBe('cab.wav');
    expect(Array.from(ampIrAsset(material)!.samples)).toEqual([0.25, -0.25, 0.5]);
  });

  it('throws when a referenced NAM/IR asset is missing from the export (readFile means decode everything)', async () => {
    const blob = jsonBlob({ namFilename: 'missing.nam' });
    const parsed = parseProject(
      JSON.stringify({
        kind: 'homecrate-project-archive',
        formatVersion: 1,
        appVersion: '0.0.1',
        exportedAt: '2026-09-05T00:00:00.000Z',
        projectId: 'p',
        projectName: 'Amp Song',
        counts: { audioFiles: 0, artworkFiles: 0, assetFiles: 0 },
      }),
      JSON.stringify({
        id: 'p',
        name: 'Amp Song',
        bpm: 120,
        timeSigN: 4,
        timeSigD: 4,
        tracks: [],
        midiTracks: [],
        master: {
          volume: 1,
          muted: false,
          pluginSlots: [
            {
              plugin: {
                componentType: AU_TYPE_EFFECT,
                componentSubType: HOMECRATE_AMP_SUBTYPE,
                componentManufacturer: HOMECRATE_AMP_MANUFACTURER,
                componentName: 'homecrate: hc_amp',
              },
              savedPresetData: blob,
            },
          ],
        },
      }),
    );

    await expect(
      loadProjectScene(parsed, {
        registry,
        readFile: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toThrow('ENOENT');
  });
});

/** A minimal mono float32 WAV, matching the shape `AudioLoader.decodeWav` expects. */
function buildMonoFloatWav(samples: number[]): Uint8Array {
  const dataBytes = samples.length * 4;
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
  samples.forEach((s, i) => data.writeFloatLE(s, 8 + i * 4));

  const body = Buffer.concat([fmt, data]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return new Uint8Array(Buffer.concat([riff, body]));
}
