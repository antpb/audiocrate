import { describe, expect, it } from 'vitest';
import {
  readProjectTempoMap,
  writeProjectTempoMap,
  loadProjectScene,
  type ProjectFileData,
  type ParsedProject,
} from '../../src/loaders/ProjectLoader';
import { TempoMap } from '../../src/TempoMap';
import { AudioScene } from '../../src/AudioScene';
import { Time } from '../../src/Time';

function project(extra: Partial<ProjectFileData> = {}): ProjectFileData {
  return {
    id: 'p1',
    name: 'Song',
    bpm: 120,
    timeSigN: 4,
    timeSigD: 4,
    tracks: [],
    midiTracks: [],
    master: { volume: 1, muted: false },
    ...extra,
  } as ProjectFileData;
}

describe('reading a tempo map from a project', () => {
  it('gives no map at all when the project has no changes', () => {
    // The path every existing project takes. A null map means the transport
    // resolves musical positions exactly as it always did.
    const result = readProjectTempoMap(project());
    expect(result.map).toBeNull();
    expect(result.changes).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('builds a map on the project bpm as its base', () => {
    const result = readProjectTempoMap(
      project({ bpm: 90, tempoChanges: [{ atBeat: 8, bpm: 140 }] }),
    );
    expect(result.map?.baseBpm).toBe(90);
    expect(result.map?.changes).toEqual([{ atBeat: 8, bpm: 140, curve: 'jump' }]);
  });

  it('reads a ramp', () => {
    const result = readProjectTempoMap(
      project({
        bpm: 60,
        tempoChanges: [
          { atBeat: 0, bpm: 60, curve: 'ramp' },
          { atBeat: 4, bpm: 120 },
        ],
      }),
    );
    expect(result.map?.hasRamps).toBe(true);
    expect(result.map?.secondsAtBeat(4)).toBeCloseTo((60 / 15) * Math.log(2), 9);
  });

  it('skips a malformed entry and says why, rather than losing the song', () => {
    const result = readProjectTempoMap(
      project({
        tempoChanges: [
          { atBeat: 4, bpm: 140 },
          { atBeat: -1, bpm: 90 },
          { atBeat: 8, bpm: 0 },
          { atBeat: Number.NaN, bpm: 90 },
          { atBeat: 12, bpm: 100, curve: 'ease' } as never,
          'nonsense' as never,
        ],
      }),
    );
    expect(result.changes).toEqual([{ atBeat: 4, bpm: 140 }]);
    expect(result.skipped.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    const reasonAt = (index: number) => result.skipped.find((s) => s.index === index)?.reason ?? '';
    expect(reasonAt(1)).toContain('negative');
    expect(reasonAt(2)).toContain('bpm');
    expect(reasonAt(3)).toContain('atBeat');
    expect(reasonAt(4)).toContain('curve');
    expect(reasonAt(5)).toContain('not an object');
  });

  it('reports a tempoChanges that is not an array', () => {
    const result = readProjectTempoMap(project({ tempoChanges: 120 as never }));
    expect(result.map).toBeNull();
    expect(result.skipped[0]!.reason).toContain('not an array');
  });

  it('gives no map when every entry was unusable', () => {
    const result = readProjectTempoMap(project({ tempoChanges: [{ atBeat: 1 } as never] }));
    expect(result.map).toBeNull();
    expect(result.skipped.length).toBe(1);
  });

  it('falls back to a sane base when bpm is missing or nonsense', () => {
    const result = readProjectTempoMap(
      project({ bpm: 0 as never, tempoChanges: [{ atBeat: 4, bpm: 140 }] }),
    );
    expect(result.map?.baseBpm).toBe(120);
  });
});

describe('writing a tempo map into a project', () => {
  it('writes nothing at all for a constant map', () => {
    // A song that does not change tempo has to produce the same file it did
    // before this field existed, not one with an empty array in it.
    const data = project();
    writeProjectTempoMap(data, TempoMap.constant(128));
    expect('tempoChanges' in data).toBe(false);
    expect(data.bpm).toBe(128);
  });

  it('removes an existing field when the map goes away', () => {
    const data = project({ tempoChanges: [{ atBeat: 4, bpm: 140 }] });
    writeProjectTempoMap(data, null);
    expect('tempoChanges' in data).toBe(false);
  });

  it('keeps bpm in step with the map base, for a reader that ignores changes', () => {
    const data = project();
    writeProjectTempoMap(data, new TempoMap([{ atBeat: 8, bpm: 140 }], 90));
    expect(data.bpm).toBe(90);
    expect(data.tempoChanges).toEqual([{ atBeat: 8, bpm: 140 }]);
  });

  it('omits a jump curve and writes a ramp one', () => {
    const data = project();
    writeProjectTempoMap(
      data,
      new TempoMap(
        [
          { atBeat: 4, bpm: 90, curve: 'ramp' },
          { atBeat: 8, bpm: 120 },
        ],
        120,
      ),
    );
    expect(data.tempoChanges).toEqual([
      { atBeat: 4, bpm: 90, curve: 'ramp' },
      { atBeat: 8, bpm: 120 },
    ]);
  });

  it('round-trips through JSON, which is what an export actually does', () => {
    const map = new TempoMap(
      [
        { atBeat: 4, bpm: 90, curve: 'ramp' },
        { atBeat: 16, bpm: 140 },
      ],
      120,
    );
    const data = project();
    writeProjectTempoMap(data, map);
    const reloaded = readProjectTempoMap(JSON.parse(JSON.stringify(data)) as ProjectFileData);
    expect(reloaded.map?.baseBpm).toBe(map.baseBpm);
    expect(reloaded.map?.changes).toEqual(map.changes);
    for (const beat of [0, 4, 10, 16, 32]) {
      expect(reloaded.map?.secondsAtBeat(beat)).toBeCloseTo(map.secondsAtBeat(beat), 12);
    }
  });
});

describe('loading a scene with a tempo map', () => {
  const manifest = {
    kind: 'homecrate-project',
    formatVersion: 1,
    appVersion: '0',
    exportedAt: '',
    projectId: 'p1',
    projectName: 'Song',
    counts: { audioFiles: 0, artworkFiles: 0, assetFiles: 0 },
  };

  async function load(data: ProjectFileData): Promise<AudioScene> {
    return loadProjectScene({ manifest, project: data } as ParsedProject);
  }

  it('leaves a constant-tempo project with no map on the transport', async () => {
    const scene = await load(project({ bpm: 128 }));
    expect(scene.transport.tempoMap).toBeNull();
    expect(scene.transport.bpm).toBe(128);
    expect('tempoMap' in scene.transport.timeContext).toBe(false);
  });

  it('installs the map and resolves musical positions through it', async () => {
    const scene = await load(project({ bpm: 120, tempoChanges: [{ atBeat: 4, bpm: 60 }] }));
    expect(scene.transport.tempoMap?.baseBpm).toBe(120);
    // Bar 3 beat 1 is beat 8: four beats at 120 then four at 60.
    expect(scene.transport.resolve(Time.bars(3, 1, 0))).toBeCloseTo(6, 9);
  });

  it('keeps the time signature and the base tempo', async () => {
    const scene = await load(
      project({ bpm: 90, timeSigN: 3, tempoChanges: [{ atBeat: 6, bpm: 120 }] }),
    );
    expect(scene.transport.beatsPerBar).toBe(3);
    expect(scene.transport.beatUnit).toBe(4);
    expect(scene.transport.bpm).toBe(90);
  });

  it('keeps a 6/8 denominator so a bar is three quarter notes', async () => {
    const scene = await load(project({ bpm: 120, timeSigN: 6, timeSigD: 8 }));
    expect(scene.transport.beatsPerBar).toBe(6);
    expect(scene.transport.beatUnit).toBe(8);
    expect(scene.transport.resolve(Time.bars(2, 1, 0))).toBeCloseTo(1.5, 9);
  });

  it('opens a project whose changes are all junk at its base tempo', async () => {
    const scene = await load(project({ bpm: 100, tempoChanges: [{ bpm: 90 } as never] }));
    expect(scene.transport.tempoMap).toBeNull();
    expect(scene.transport.bpm).toBe(100);
  });
});

describe('a tempo map through an export', () => {
  it('survives the archive round trip', async () => {
    // The exporter copies `project.json` wholesale, so this is really a test
    // that nothing along the way strips an unknown field. That is worth
    // asserting: the whole compatibility story depends on it.
    const { exportProject } = await import('../../src/loaders/ProjectExporter');
    const map = new TempoMap(
      [
        { atBeat: 4, bpm: 90, curve: 'ramp' },
        { atBeat: 16, bpm: 140 },
      ],
      120,
    );
    const data = project();
    writeProjectTempoMap(data, map);

    const written = new Map<string, Uint8Array>();
    await exportProject(data, {
      readFile: async () => null,
      writeFile: async (name, bytes) => {
        written.set(name, bytes);
      },
    });

    const json = new TextDecoder().decode(written.get('project.json')!);
    const reloaded = readProjectTempoMap(JSON.parse(json) as ProjectFileData);
    expect(reloaded.map?.changes).toEqual(map.changes);
    expect(reloaded.skipped).toEqual([]);
  });
});
