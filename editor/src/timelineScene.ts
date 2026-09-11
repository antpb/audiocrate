/**
 * Imported songs schedule clips and MIDI on crate's AudioScene: one origin,
 * PDC, dry clip buffers, live instruments.
 *
 * Kernel inserts stay off that scheduler. After Play, the editor lifts each
 * track's clip mix and instrument out of the DAW fader and wires them
 * through the graph: native gain/pan, dry passthrough for the rest.
 */
import {
  AudioScene,
  Clip,
  MidiClip,
  Time,
  Track,
  sampleAsset,
  type AudioBufferLike,
  type AudioMaterial,
  buildScenePlan,
  type ScenePlan,
  type PlanBuildClip,
  type PlanBuildTrack,
} from '../../src/index';
import { isNoteInlet } from './controlInputs';
import type { PatchEditor } from './editor';
import type { PatchTransport } from './patch';
import { isMasterKind, isMidiClipKind } from './tools';
import { jackFromOutputs, type JackActivity, type NodeActivity } from './activity';
import { placeMidiClip } from './midiClipData';

export interface TimelineLink {
  source: string;
  sourceOutput: string;
  target: string;
  targetInput: string;
}

export interface TimelineSource {
  kinds: Map<string, string>;
  materials: Map<string, AudioMaterial>;
  nodeIds: readonly string[];
  connections: readonly TimelineLink[];
  transport: PatchTransport | null;
  nodeData(id: string): Record<string, unknown> | undefined;
}

export interface TimelineLane {
  key: string;
  sampleIds: string[];
  midiIds: string[];
  instId: string | null;
  gainId: string | null;
  panId: string | null;
}

export function editorTimelineSource(editor: PatchEditor): TimelineSource {
  editor.syncTransportFromGraph();
  return {
    kinds: editor.kinds,
    materials: editor.materials,
    nodeIds: editor.editor.getNodes().map((node) => node.id),
    connections: editor.editor.getConnections().map((conn) => ({
      source: conn.source,
      sourceOutput: conn.sourceOutput,
      target: conn.target,
      targetInput: conn.targetInput,
    })),
    transport: editor.transport,
    nodeData: (id) => editor.nodeData(id),
  };
}

export function hasScheduledClipData(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const offset = Number(data.clipOffsetSec ?? data.offsetSec);
  const duration = Number(data.clipDurationSec);
  if (Number.isFinite(offset) && offset >= 0) return true;
  return Number.isFinite(duration) && duration > 0;
}

export function patchUsesTimeline(source: TimelineSource): boolean {
  for (const id of source.nodeIds) {
    const kind = source.kinds.get(id) ?? '';
    if (kind === 'sampleplayer' && hasScheduledClipData(source.nodeData(id))) return true;
    if (isMidiClipKind(kind) && hasScheduledClipData(source.nodeData(id))) return true;
  }
  return false;
}

export function laneKeyForNode(id: string, kind: string, data: Record<string, unknown> | undefined): string | null {
  const track = id.match(/^t(\d+)-/);
  if (track) return `t${track[1]}`;
  const midi = id.match(/^midi-(\d+)-/);
  if (midi) return `t${midi[1]}`;
  if (kind === 'sampleplayer' && hasScheduledClipData(data)) return `solo-${id}`;
  return null;
}

export function collectTimelineLanes(source: TimelineSource): TimelineLane[] {
  const lanes = new Map<string, TimelineLane>();
  const take = (key: string): TimelineLane => {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { key, sampleIds: [], midiIds: [], instId: null, gainId: null, panId: null };
      lanes.set(key, lane);
    }
    return lane;
  };

  for (const id of source.nodeIds) {
    const kind = source.kinds.get(id) ?? '';
    const key = laneKeyForNode(id, kind, source.nodeData(id));
    if (!key) continue;
    const lane = take(key);
    if (kind === 'sampleplayer') lane.sampleIds.push(id);
    else if (isMidiClipKind(kind)) lane.midiIds.push(id);
    else if (kind === 'gain' && id.endsWith('-gain')) lane.gainId = id;
    else if (kind === 'stereopan') lane.panId = id;
    else if (id.endsWith('-inst') || isInstrumentNode(kind, source.materials.get(id))) lane.instId = id;
  }

  for (const conn of source.connections) {
    if (!isMidiClipKind(source.kinds.get(conn.source) ?? '')) continue;
    if (!isNoteInlet(conn.targetInput)) continue;
    const destKey = laneKeyForNode(conn.target, source.kinds.get(conn.target) ?? '', source.nodeData(conn.target));
    if (!destKey) continue;
    const lane = take(destKey);
    if (!lane.midiIds.includes(conn.source)) lane.midiIds.push(conn.source);
    if (!lane.instId) lane.instId = conn.target;
  }

  return [...lanes.values()].filter(
    (lane) => lane.sampleIds.length > 0 || lane.midiIds.length > 0 || lane.instId != null,
  );
}

export function laneMeterNodes(lane: TimelineLane): string[] {
  const ids = [...lane.sampleIds, ...lane.midiIds];
  if (lane.instId) ids.push(lane.instId);
  if (lane.gainId) ids.push(lane.gainId);
  if (lane.panId) ids.push(lane.panId);
  return ids;
}

export function masterMeterNodes(source: Pick<TimelineSource, 'nodeIds' | 'kinds'>): string[] {
  return source.nodeIds.filter((id) => {
    const kind = source.kinds.get(id) ?? '';
    return isMasterKind(kind) || id === 'master-gain' || id.startsWith('master-');
  });
}

export function spreadActivity(
  seeds: Map<string, JackActivity>,
  connections: readonly TimelineLink[],
): Map<string, NodeActivity> {
  const frames = new Map<string, NodeActivity>();
  const take = (id: string): NodeActivity => {
    let frame = frames.get(id);
    if (!frame) {
      frame = { outputs: {}, inputs: {} };
      frames.set(id, frame);
    }
    return frame;
  };
  const paintOut = (id: string, jack: JackActivity) => {
    const frame = take(id);
    frame.outputs.audio = jack;
    frame.outputs.cv = jack;
    frame.outputs.gate = jack;
  };

  const queue: string[] = [];
  const peak = new Map<string, number>();
  for (const [id, jack] of seeds) {
    paintOut(id, jack);
    peak.set(id, jack.peak);
    queue.push(id);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const frame = frames.get(id);
    if (!frame) continue;
    for (const conn of connections) {
      if (conn.source !== id) continue;
      const jack = jackFromOutputs(frame.outputs, conn.sourceOutput);
      const dest = take(conn.target);
      dest.inputs[conn.targetInput] = jack;
      const prev = peak.get(conn.target) ?? -1;
      if (jack.peak <= prev) continue;
      paintOut(conn.target, jack);
      peak.set(conn.target, jack.peak);
      queue.push(conn.target);
    }
  }
  return frames;
}

export function overlaySpread(
  frames: Map<string, NodeActivity>,
  connections: readonly TimelineLink[],
): Map<string, NodeActivity> {
  const seeds = new Map<string, JackActivity>();
  for (const [id, frame] of frames) {
    const jack = jackFromOutputs(frame.outputs, 'audio');
    if (jack.peak > 0.01) seeds.set(id, jack);
  }
  if (seeds.size === 0) return frames;
  const spread = spreadActivity(seeds, connections);
  for (const [id, painted] of spread) {
    const frame = frames.get(id) ?? { outputs: {}, inputs: {} };
    const local = jackFromOutputs(frame.outputs, 'audio');
    const incoming = painted.outputs.audio;
    if (incoming && incoming.peak > local.peak) {
      frame.outputs.audio = incoming;
      frame.outputs.cv = incoming;
      frame.outputs.gate = incoming;
    }
    for (const [name, jack] of Object.entries(painted.inputs)) {
      const prev = frame.inputs[name];
      if (!prev || jack.peak > prev.peak) frame.inputs[name] = jack;
    }
    frames.set(id, frame);
  }
  return frames;
}

export function clipPlacementFromPlayer(
  material: AudioMaterial,
  data: Record<string, unknown> | undefined,
): {
  buffer: AudioBufferLike;
  offsetSec: number;
  trimStartSec: number;
  trimEndSec: number | null;
  stretchRatio: number;
  gainDb: number;
} | null {
  const sample = sampleAsset(material);
  if (!sample || sample.samples.length < 2) return null;
  const srcRate = sample.sampleRate > 0 ? sample.sampleRate : 44100;
  const fileSec = sample.samples.length / srcRate;
  const startFrac = material.getParam('start');
  const trimStartSec = Math.min(Math.max(Number.isFinite(startFrac) ? startFrac : 0, 0), 1) * fileSec;
  const rate = material.getParam('rate');
  const stretchRatio = Number.isFinite(rate) && rate > 0 ? 1 / rate : 1;
  const clipDur = Number(data?.clipDurationSec);
  const trimSpan =
    Number.isFinite(clipDur) && clipDur > 0 ? clipDur / stretchRatio : Math.max(0, fileSec - trimStartSec);
  const gain = material.getParam('gain');
  const offset = Number(data?.clipOffsetSec);
  return {
    buffer: assetBuffer(sample),
    offsetSec: Number.isFinite(offset) && offset > 0 ? offset : 0,
    trimStartSec,
    trimEndSec: trimStartSec + trimSpan,
    stretchRatio,
    gainDb: linearToDb(Number.isFinite(gain) ? gain : 1),
  };
}

/**
 * The editor's timeline as a `ScenePlan`, plus the buffers a plan does not
 * carry.
 *
 * This exists to prove something rather than to be convenient. `ScenePlan` was
 * designed against its own conformance cases, and a format tested only against
 * cases written for it will describe those cases and nothing else. So the
 * editor's timeline, which is a real if small session host, is routed through
 * the document instead of straight into an `AudioScene`, and whatever will not
 * fit is thereby made visible rather than argued about.
 *
 * What did not fit, honestly: **instruments and MIDI clips**. Plan format v1
 * carries audio clips, track topology, automation and the transport, and
 * `fillTimelineScene` still attaches instruments and MIDI clips outside the
 * plan. That is a stated gap in the format rather than a shortcut here, and
 * converting this host is what turned it from a note in a handoff into two
 * lines of code that visibly bypass the document.
 *
 * `source` is the node id, which is stable within a patch and is not a path.
 * The buffers come back beside the plan because a plan names sources and a
 * host resolves them; keeping them in the same return value is this host's
 * resolution step, not part of the document.
 */
export function editorTimelinePlan(source: TimelineSource): {
  plan: ScenePlan;
  buffers: Map<string, AudioBufferLike>;
  lanes: TimelineLane[];
} {
  const transport = source.transport;
  const lanes = collectTimelineLanes(source);
  const buffers = new Map<string, AudioBufferLike>();
  const clips: PlanBuildClip[] = [];
  const tracks: PlanBuildTrack[] = [];

  lanes.forEach((lane, index) => {
    const volume = nodeParam(source, lane.gainId, 'gain', 1);
    tracks.push({
      index,
      volume,
      pan: nodeParam(source, lane.panId, 'pan', 0),
      // The editor has no mute control; a fader at zero is how a lane is
      // silenced, and the plan says so explicitly rather than leaving a host
      // to infer it from the gain.
      muted: volume <= 0,
      latencySamples: 0,
    });
    for (const id of lane.sampleIds) {
      const material = source.materials.get(id);
      const placed = material ? clipPlacementFromPlayer(material, source.nodeData(id)) : null;
      if (!placed) continue;
      buffers.set(id, placed.buffer);
      clips.push({
        audioFileUri: id,
        id,
        trackIndex: index,
        offsetMs: placed.offsetSec * 1000,
        trimStartMs: placed.trimStartSec * 1000,
        trimEndMs: placed.trimEndSec != null ? placed.trimEndSec * 1000 : null,
        stretchRatio: placed.stretchRatio,
        clipGainDb: placed.gainDb,
      });
    }
  });

  const plan = buildScenePlan({
    clips,
    tracks,
    bpm: transport?.bpm && transport.bpm > 0 ? transport.bpm : 120,
    beatsPerBar: transport?.beatsPerBar && transport.beatsPerBar > 0 ? transport.beatsPerBar : 4,
    beatUnit: transport?.beatUnit && transport.beatUnit > 0 ? transport.beatUnit : 4,
    master: { volume: masterVolume(source) },
    // The node id, which is stable within a patch and is not a path.
    sourceId: (clip) => clip.audioFileUri,
  });

  return { plan, buffers, lanes };
}

export function resetTimelineScene(scene: AudioScene): void {
  try {
    scene.transport.stop();
  } catch {
    /* scene may not have played yet */
  }
  scene.disposeLiveVoices();
  while (scene.tracks.length > 0) scene.removeTrack(scene.tracks[0]!);
  for (const material of [...scene.master.materials.list]) scene.master.materials.remove(material);
  scene.master.latencySamples = 0;
}

export function fillTimelineScene(
  scene: AudioScene,
  source: TimelineSource,
): { tracks: number; clips: number; midi: number; bindings: Array<{ trackId: number; lane: TimelineLane }> } {
  resetTimelineScene(scene);

  // Everything the editor knows about its timeline, as a document. The scene
  // below is built from the plan rather than from the editor, which is the
  // point: if the plan cannot say it, this host cannot play it.
  const { plan, buffers, lanes } = editorTimelinePlan(source);

  scene.transport.bpm = plan.transport.bpm;
  scene.transport.beatsPerBar = plan.transport.beatsPerBar ?? 4;
  scene.transport.beatUnit = plan.transport.beatUnit ?? 4;
  scene.master.volume = plan.master.volume;
  scene.master.muted = scene.master.volume <= 0;

  let clips = 0;
  let midi = 0;
  const bindings: Array<{ trackId: number; lane: TimelineLane }> = [];

  plan.tracks.forEach((planned, index) => {
    const lane = lanes[index];
    if (!lane) return;
    const track = scene.addTrack(new Track({ name: lane.key }));
    track.volume = planned.volume;
    track.pan = planned.pan;
    track.muted = planned.muted;
    track.latencySamples = planned.latencySamples;

    // Outside the plan: format v1 carries no instrument. A stated gap, left
    // visible rather than worked around.
    if (lane.instId) {
      const instrument = source.materials.get(lane.instId);
      if (instrument) track.instrument = instrument;
    }

    for (const planClip of planned.clips) {
      const buffer = buffers.get(planClip.source);
      if (!buffer) continue;
      track.addClip(
        new Clip({
          buffer,
          region: { trimStartSec: planClip.trimStartSec, trimEndSec: planClip.trimEndSec },
          stretchRatio: planClip.stretchRatio,
          gainDb: planClip.gainDb,
        }),
        { at: Time.seconds(planClip.offsetSec) },
      );
      clips += 1;
    }

    // Outside the plan: format v1 carries no MIDI clips. The other stated gap.
    for (const id of lane.midiIds) {
      const placed = placeMidiClip(source.nodeData(id));
      if (placed.notes.length === 0) continue;
      track.addMidiClip(new MidiClip({ notes: placed.notes }), {
        at: Time.seconds(placed.offsetSec),
      });
      midi += 1;
    }
    bindings.push({ trackId: track.id, lane });
  });

  return { tracks: lanes.length, clips, midi, bindings };
}

function isInstrumentNode(kind: string, material: AudioMaterial | undefined): boolean {
  if (kind === 'synth') return true;
  return Boolean(material && material.audioInputs.length === 0 && (kind === 'grain' || material.polyphony > 1));
}

function nodeParam(source: TimelineSource, id: string | null, name: string, fallback: number): number {
  if (!id) return fallback;
  const value = source.materials.get(id)?.getParam(name);
  return Number.isFinite(value) ? (value as number) : fallback;
}

function masterVolume(source: TimelineSource): number {
  for (const id of source.nodeIds) {
    if (id !== 'master-gain' && !(source.kinds.get(id) === 'gain' && id.startsWith('master-'))) continue;
    const value = source.materials.get(id)?.getParam('gain');
    if (Number.isFinite(value)) return value as number;
  }
  return 1;
}

function linearToDb(gain: number): number {
  if (!(gain > 0)) return -60;
  return 20 * Math.log10(gain);
}

function assetBuffer(sample: { samples: Float32Array; samplesR?: Float32Array; sampleRate: number }): AudioBufferLike {
  const right = sample.samplesR && sample.samplesR.length >= 2 ? sample.samplesR : undefined;
  const frames = right ? Math.min(sample.samples.length, right.length) : sample.samples.length;
  const left = sample.samples.length === frames ? sample.samples : sample.samples.subarray(0, frames);
  const side = right && right.length !== frames ? right.subarray(0, frames) : right;
  return {
    sampleRate: sample.sampleRate > 0 ? sample.sampleRate : 44100,
    length: frames,
    numberOfChannels: side ? 2 : 1,
    getChannelData: (channel) => (channel === 1 && side ? side : left),
  };
}
