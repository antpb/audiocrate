import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerHomecrateMaterials } from '../../examples/homecrate/src/index';
import { Bus } from '../../src/graph/Bus';
import { Track } from '../../src/graph/Track';
import type { AudioBufferLike } from '../../src/graph/Clip';
import { compileVoice } from '../../src/asl/compile';
import {
  NUM_PADS,
  PAD_BASE_NOTE,
  createDrumMaterial,
  drumPadAsset,
  drumPadBoxes,
  ensureDrumPadBoxes,
  liveDrumGraph,
  padIndexFromNote,
} from '../../examples/drum/src/index';
import { applyDrumPad } from '../src/nodeAssets';
import { isMidiClipKind } from '../src/tools';
import { placeMidiClip } from '../src/midiClipData';
import { clipPlaybackWindows, sampleAsset } from '../../src/index';
import { ScenePlayback } from '../../src/playback/ScenePlayback';
import type { PlaybackPlan, PlannedClipJob } from '../../src/playback/plan';
import { importProjectBytes } from '../src/importProject';
import { clipPlacementFromPlayer, editorTimelinePlan } from '../src/timelineScene';

registerHomecrateMaterials();

const ZIP = `${process.env.HOME}/Downloads/Fine 91.zip`;

function fakeCtx(sampleRate: number) {
  const destination = { connect() {}, disconnect() {} };
  const sources: Array<{
    buffer: { sampleRate: number; length: number } | null;
    playbackRate: { value: number };
    startArgs: unknown[] | null;
    connect() : void;
    start(...args: unknown[]): void;
    stop(): void;
    disconnect(): void;
  }> = [];
  return {
    sources,
    ctx: {
      currentTime: 0,
      sampleRate,
      destination,
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
      createStereoPanner: () => ({ pan: { value: 0 }, connect() {}, disconnect() {} }),
      createBufferSource: () => {
        const source = {
          buffer: null as { sampleRate: number; length: number } | null,
          playbackRate: { value: 1 },
          startArgs: null as unknown[] | null,
          connect() {},
          start(...args: unknown[]) {
            source.startArgs = args;
          },
          stop() {},
          disconnect() {},
        };
        sources.push(source);
        return source;
      },
      createBuffer: (channels: number, length: number, rate: number) => {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          sampleRate: rate,
          length,
          copyToChannel: (d: Float32Array, ch: number) => data[ch]!.set(d),
          getChannelData: (ch: number) => data[ch]!,
        };
      },
    },
  };
}

function emptyPlan(jobs: PlannedClipJob[]): PlaybackPlan {
  return {
    jobs,
    midiJobs: [],
    midiCcJobs: [],
    playheadSec: 0,
    maxTrackLatencySamples: 0,
    masterLatencySamples: 0,
    sampleRate: 48000,
  };
}

describe('Fine 91 zip (real export)', () => {
  it('imports 44.1 kHz clips and plays them at stretch 1 on a 48 kHz context', async () => {
    expect(existsSync(ZIP), `missing ${ZIP}`).toBe(true);
    const imported = await importProjectBytes(new Uint8Array(readFileSync(ZIP)));
    const kinds = new Map(imported.patch.nodes.map((node) => [node.id, node.kind]));
    const materials = new Map(imported.assets.map((item) => [item.nodeId, item.material]));
    const data = new Map(imported.patch.nodes.map((node) => [node.id, node.data ?? {}]));
    const { plan, buffers } = editorTimelinePlan({
      kinds,
      materials,
      nodeIds: imported.patch.nodes.map((node) => node.id),
      connections: imported.patch.connections,
      transport: imported.patch.transport ?? null,
      nodeData: (id) => data.get(id),
    });

    const players = imported.patch.nodes.filter((node) => node.kind === 'sampleplayer');
    expect(imported.warnings.join(' ')).not.toMatch(/Could not decode/);
    expect(imported.patch.nodes.some((node) => node.kind === 'drum')).toBe(true);
    expect(imported.warnings.join(' ')).not.toMatch(/Missing homecrate_/);
    const drum = imported.assets.find((item) => item.kind === 'drum');
    expect(drum, 'imported drum material').toBeTruthy();
    const loadedPads = Array.from({ length: NUM_PADS }, (_, pad) => drumPadAsset(drum!.material, pad)).filter(Boolean);
    expect(loadedPads.length).toBeGreaterThanOrEqual(12);
    expect(loadedPads.every((asset) => (asset?.samples.length ?? 0) >= 2)).toBe(true);
    const boxes = drumPadBoxes(drum!.material);
    expect(boxes, 'import must write pad PCM into the playheads, not only setAsset').toBeTruthy();
    expect(boxes!.filter((box) => box.samples.length >= 2).length).toBeGreaterThanOrEqual(12);
    const dest = createDrumMaterial();
    for (let pad = 0; pad < NUM_PADS; pad++) {
      const asset = drumPadAsset(drum!.material, pad);
      if (asset) applyDrumPad(dest, pad, asset);
    }
    const destBoxes = drumPadBoxes(dest);
    expect(destBoxes!.filter((box) => box.samples.length >= 2).length).toBeGreaterThanOrEqual(12);
    const midiNotes = imported.patch.nodes
      .filter((node) => isMidiClipKind(node.kind))
      .flatMap((node) => placeMidiClip(node.data).notes);
    for (const note of midiNotes) {
      expect(padIndexFromNote(note.pitch), `midi pitch ${note.pitch}`).not.toBeNull();
    }
    ensureDrumPadBoxes(drum!.material);
    const voice = compileVoice(structuredClone(liveDrumGraph(drum!.material)));
    const state = voice.createState();
    voice.noteOn(state, { ...drum!.material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 0.85 });
    const left = new Float32Array(512);
    voice.renderBlock(state, 48000, left);
    let peak = 0;
    for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]!));
    expect(peak, 'imported kit must speak through the live graph').toBeGreaterThan(0.01);
    const cloned = structuredClone(liveDrumGraph(drum!.material));
    const clonedVoice = compileVoice(cloned);
    const clonedState = clonedVoice.createState();
    clonedVoice.noteOn(clonedState, { ...drum!.material.snapshotParams(), note: PAD_BASE_NOTE, velocity: 0.85 });
    const clonedLeft = new Float32Array(512);
    clonedVoice.renderBlock(clonedState, 48000, clonedLeft);
    let clonedPeak = 0;
    for (let i = 0; i < clonedLeft.length; i++) clonedPeak = Math.max(clonedPeak, Math.abs(clonedLeft[i]!));
    expect(clonedPeak, 'kit tables must survive the worklet structured clone').toBeGreaterThan(0.01);
    expect(players.length).toBe(14);
    expect(buffers.size).toBe(14);

    const track = new Track({ name: 'Fine91' });
    const jobs: PlannedClipJob[] = [];
    const nativeBuffers = new Map<number, AudioBufferLike>();
    let clipId = 1;
    for (const node of players) {
      const material = materials.get(node.id);
      const placed = material ? clipPlacementFromPlayer(material, node.data) : null;
      const sample = material ? sampleAsset(material) : undefined;
      expect(sample?.sampleRate, node.id).toBe(44100);
      expect(placed, node.id).not.toBeNull();
      expect(placed!.stretchRatio, node.id).toBe(1);
      const windows = clipPlaybackWindows({
        offsetSec: placed!.offsetSec,
        trimStartSec: placed!.trimStartSec,
        trimEndSec: placed!.trimEndSec,
        stretchRatio: placed!.stretchRatio,
        playheadSec: 0,
      });
      expect(windows.length, node.id).toBeGreaterThan(0);
      for (const win of windows) {
        expect(win.playbackRate, node.id).toBe(1);
        expect(44100 / 48000).toBeCloseTo(0.91875, 8);
        jobs.push({
          trackId: track.id,
          clipId,
          whenSec: win.whenSec,
          fileOffsetSec: win.fileOffsetSec,
          fileDurationSec: win.fileDurationSec,
          playbackRate: win.playbackRate,
          volume: 1,
          pan: 0,
          pdcSec: 0,
          fadeInSec: 0,
          fadeOutSec: 0,
          fadeInCurve: 'linear',
          fadeOutCurve: 'linear',
          gainDb: 0,
          trimStartSec: placed!.trimStartSec,
          trimEndSec: placed!.trimEndSec ?? placed!.trimStartSec + win.fileDurationSec,
        });
        nativeBuffers.set(clipId, buffers.get(node.id)!);
        clipId += 1;
      }
    }

    expect(plan.tracks.flatMap((track) => track.clips).length).toBe(14);

    const { ctx, sources } = fakeCtx(48000);
    new ScenePlayback().start(ctx as never, [track], new Bus({ name: 'Master' }), emptyPlan(jobs), nativeBuffers);

    expect(sources.length).toBe(14);
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      const job = jobs[i]!;
      const file = nativeBuffers.get(job.clipId)!;
      expect(source.buffer?.sampleRate, `clip ${job.clipId}`).toBe(48000);
      expect((source.buffer?.length ?? 0) / 48000, `clip ${job.clipId} duration`).toBeCloseTo(
        file.length / file.sampleRate,
        5,
      );
      expect(source.playbackRate.value, `clip ${job.clipId}`).toBe(1);
      const args = source.startArgs ?? [];
      expect(args[1], `clip ${job.clipId} offset`).toBeCloseTo(job.fileOffsetSec, 8);
      expect(args[2], `clip ${job.clipId} duration`).toBeCloseTo(job.fileDurationSec, 8);
    }
  }, 180_000);
});
