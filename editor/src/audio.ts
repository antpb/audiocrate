import {
  AudioScene,
  LOOPER_END_TAP,
  LOOPER_OUTPUTS,
  LOOPER_START_TAP,
  TRANSPORT_OUTPUTS,
  VoicePool,
  WebAudioRenderer,
  analysisOutputs,
  barBeats,
  isAnalysisAbsoluteOutput,
  isLooperKind,
  isLooperPulseOutput,
  isTransportAbsoluteOutput,
  isTransportKind,
  audioMaterialRegistry,
  disposeVoiceHandle,
  resolvedTransport,
  sampleAsset,
  type AudioContextLike,
  type AudioMaterial,
  type TransportAnchor,
  type TransportOutput,
  type VoiceBackend,
  type VoiceHandle,
  MIDI_IN_OUTPUTS,
  MIDI_OUT_INPUTS,
  DEFAULT_MIDI_IN_FIELDS,
  DEFAULT_MIDI_OUT_FIELDS,
  MidiInputMonitor,
  createMidiOutputState,
  encodeMidiVoiceEvent,
  findMidiInput,
  findMidiOutput,
  isMidiInOutput,
  listenMidiInput,
  midiInputChannel,
  parseMidiBytes,
  readMidiIoFields,
  requestMidiAccess,
  stepMidiOutput,
  type MidiIoFields,
  type MidiOutputCables,
  type MidiOutputState,
  type MidiInputSnapshot,
  type WebMidiAccessPorts,
  type WebMidiOutputLike,
  MIDI_TRIG_SECONDS,
  emptyMidiCables,
  emptyMidiSample,
  midiInOutlets,
  midiOutSample,
  midiVelocity,
  type MidiInletReading,
} from '../../src/index';
import { patcherKernelBinaries } from './kernels';
import { fillTimelineScene, editorTimelineSource, overlaySpread, patchUsesTimeline, resetTimelineScene, type TimelineLane } from './timelineScene';
import { openInput, type OpenInputResult } from './host/crateAudioInput';
import { EDITOR_WORKLET_URL } from './host/workletUrl';
import {
  attachNodeToHtmlSink,
  getSharedWebAudioContext,
  setWebAudioWantRunning,
  unlockWebAudio,
} from './host/webAudioContext';
import {
  KEYBOARD_OUTPUTS,
  TRIG_SECONDS,
  isKeyboardKind,
  stealLabel,
  type AnalogEvent,
  type AnalogKeyboard,
  type AnalogSnapshot,
  type KeyboardOutput,
} from './analogKeyboard';
import { activityBus, holdPeak, jackFromOutputs, loudestJack, meterRefresh, METER_SLOW_MS, readAnalyser, type JackActivity, type NodeActivity } from './activity';
import { analysisBus, analysisOutletValue, deriveAnalysis } from './analysisBus';
import { isAnalysisKind } from './analysisKinds';
import { liveNodeIds } from './graphReach';
import { controlInputs, isAudioInlet, isCvInlet, isNoteInlet, tapOutputNames } from './controlInputs';
import { mapModulatorToParam } from './cvMap';
import type { PatchEditor } from './editor';
import { normalizeLineDeviceId } from './storage';
import { placeMidiClip } from './midiClipData';
import { createNativeGain, createNativeStereoPan } from './nativeMixer';
import { prepareClipBuffer } from './resampleAudio';
import { lineMonitorOn } from './lineInput';
import { isLineKind, isMasterKind, isMidiClipKind, isMidiInKind, isMidiOutKind } from './tools';
import {
  drumLiveNote,
  drumPadAsset,
  ensureDrumPadBoxes,
  liveDrumGraph,
  padIndexFromNote,
  padParamName,
} from '../../examples/drum/src/index';
import {
  createSpatialMaster,
  createSpatialSource,
  isSpatialMasterKind,
  isSpatialSourceKind,
} from './spatialNodes';

interface KeyboardJacks {
  cv: ConstantSourceNode;
  gate: ConstantSourceNode;
  trig: ConstantSourceNode;
  velocity: ConstantSourceNode;
}

interface MidiInJacks {
  cv: ConstantSourceNode;
  gate: ConstantSourceNode;
  trig: ConstantSourceNode;
  velocity: ConstantSourceNode;
  note: ConstantSourceNode;
  cc: ConstantSourceNode;
}

interface MidiOutLive {
  state: MidiOutputState;
  fields: MidiIoFields;
  output: WebMidiOutputLike | null;
}

interface TransportJacks {
  bpm: ConstantSourceNode;
  beats: ConstantSourceNode;
  bars: ConstantSourceNode;
  playing: ConstantSourceNode;
  beatsPerBar: ConstantSourceNode;
  beatUnit: ConstantSourceNode;
  pulse: AudioNode;
}

interface AnalysisJacks {
  audio: AudioNode;
  scalars: Map<string, ConstantSourceNode>;
  held: { note: number; hz: number; cents: number };
}

interface LooperJacks {
  audio: AudioNode;
  start: ConstantSourceNode;
  end: ConstantSourceNode;
}

interface Tap {
  node: AudioNode;
  analyser: AnalyserNode;
  buffer: Float32Array;
  wave: Float32Array;
  heldPeak: number;
  lastMs: number;
}

interface LiveNode {
  mix: GainNode;
  input?: AudioNode;
  handles: VoiceHandle[];
  pool: VoicePool | null;
  kernelPoly: boolean;
  nativeSetParam?: (name: string, value: number) => void;
  /**
   * Params a cable drives at audio rate instead of through `applyCv`.
   * Present on spatial nodes, whose position has to move per sample rather
   * than per meter frame. `applyCv` skips any name that appears here, since
   * a connected signal adds to the param's value and writing both would
   * apply the modulation twice.
   */
  audioParams?: Record<string, AudioParam>;
  dispose?: () => void;
}

const TESTER_VOICE_CAP = 8;

const METER_INTERVAL_MS = 50;
const CV_SEND_EPSILON = 0.001;

export class PatchAudio {
  private scene: AudioScene | null = null;
  private renderer: WebAudioRenderer | null = null;
  private lives = new Map<string, LiveNode>();
  private jacks = new Map<string, KeyboardJacks>();
  private midiInJacks = new Map<string, MidiInJacks>();
  private midiInMonitors = new Map<string, MidiInputMonitor>();
  private midiInUnsubs = new Map<string, () => void>();
  private midiOuts = new Map<string, MidiOutLive>();
  private midiAccess: WebMidiAccessPorts | null = null;
  private midiPulseLatch = new Set<string>();
  private lastMidiOutMs = 0;
  private transportJacks = new Map<string, TransportJacks>();
  private analysisJacks = new Map<string, AnalysisJacks>();
  private looperJacks = new Map<string, LooperJacks>();
  private lastAnchor: TransportAnchor | null = null;
  private lines = new Map<string, { source: AudioNode; gain: GainNode }>();
  private taps = new Map<string, Tap>();
  private master: GainNode | null = null;
  private speaker: GainNode | null = null;
  masterMonitor = true;
  lineDeviceId: string | null = null;
  lineOpenError: string | null = null;
  private editor: PatchEditor | null = null;
  private analog: AnalogKeyboard | null = null;
  private unsub: (() => void) | null = null;
  private raf = 0;
  private lastMeter = 0;
  private armWaiters: Array<() => void> = [];
  private tapFrames = new Map<string, NodeActivity>();
  /** Reused by `cvSourceIds`, so the meter frame allocates nothing to ask. */
  private readonly cvSources = new Set<string>();
  /** The last value sent for each CV-driven parameter, keyed `node:param`. */
  private readonly lastCv = new Map<string, number>();
  private lineOpen: OpenInputResult | null = null;
  private arming = false;
  private armToken = 0;
  private analysisUnsubs: (() => void)[] = [];
  private clipSources: AudioBufferSourceNode[] = [];
  private playTimers: number[] = [];
  private wireSig = '';
  private timelinePlaying = false;
  /** Node ids present when Play armed. Drops after that are attached live. */
  private knownGraphIds = new Set<string>();
  private syncChain: Promise<void> = Promise.resolve();
  private meterSink: GainNode | null = null;
  private meterFast = false;
  private meterQuietMs = 0;
  private lastMeterTick = 0;
  private meterTimer = 0;
  playing = false;

  attachKeyboard(analog: AnalogKeyboard): void {
    this.unsub?.();
    this.analog = analog;
    this.unsub = analog.on((event) => this.onAnalog(event));
  }

  /**
   * Same turn as a tap. After the first await, iOS will not unlock.
   * Call this before `play()` / a key press awaits anything.
   */
  unlock(): void {
    unlockWebAudio();
    setWebAudioWantRunning(true);
  }

  contextState(): string {
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    return ctx?.state ?? 'idle';
  }

  sampleRate(): number | null {
    const ctx = (this.scene?.audioContext ?? getSharedWebAudioContext()) as AudioContext | undefined;
    return ctx && ctx.sampleRate > 0 ? ctx.sampleRate : null;
  }

  /**
   * Drops the live graph so the next Play builds on a new AudioContext.
   * Sample rate and latencyHint are constructor-only.
   */
  reinitialize(): void {
    this.stop();
    this.scene = null;
    this.renderer = null;
    this.master = null;
    this.speaker = null;
  }

  async start(): Promise<void> {
    this.unlock();
    if (this.scene) {
      await this.resumeIfNeeded();
      return;
    }
    const ctx = getSharedWebAudioContext();
    const scene = new AudioScene({ createContext: () => ctx as unknown as AudioContextLike });
    await scene.start();
    await this.resumeIfNeeded();
    this.scene = scene;
    this.renderer = new WebAudioRenderer(ctx, { workletUrl: EDITOR_WORKLET_URL });
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.speaker = ctx.createGain();
    this.speaker.gain.value = this.masterMonitor ? 1 : 0;
    this.master.connect(this.speaker);
    attachNodeToHtmlSink(this.speaker, ctx.destination);
    this.taps.set('__master', makeTap(ctx, this.master));
  }

  async play(editor: PatchEditor): Promise<void> {
    this.unlock();
    if (this.playing) {
      await this.resumeIfNeeded();
      return;
    }
    if (this.arming) {
      await new Promise<void>((resolve) => {
        this.armWaiters.push(resolve);
      });
      if (this.playing) {
        await this.resumeIfNeeded();
        return;
      }
    }
    const token = ++this.armToken;
    this.arming = true;
    try {
      await this.arm(editor, token);
    } finally {
      if (token === this.armToken) this.arming = false;
      const waiters = this.armWaiters;
      this.armWaiters = [];
      for (const done of waiters) done();
    }
  }

  private async arm(editor: PatchEditor, token: number): Promise<void> {
    await this.start();
    await this.resumeIfNeeded();
    this.stopVoices();
    this.editor = editor;
    if (patchUsesTimeline(editorTimelineSource(editor))) {
      await this.armTimeline(editor, token);
      return;
    }
    const renderer = this.renderer!;
    const ctx = this.scene!.audioContext as unknown as AudioContext;
    const snapshot = this.analog?.snapshot;
    const pendingLines: string[] = [];
    const pendingMidiIn: string[] = [];
    const pendingMidiOut: string[] = [];
    const liveIds = liveNodeIds(
      editor.editor.getNodes().map((node) => ({ id: node.id, kind: editor.kinds.get(node.id) ?? '' })),
      editor.editor.getConnections().map((conn) => ({ source: conn.source, target: conn.target })),
    );
    // `crate-foa-encoder` lives in the same bundle as the voice processor,
    // and `new AudioWorkletNode` throws for a name that is not registered
    // yet. A patch may contain a spatial node and no instrument, so waiting
    // for the first voice to load the module is not enough.
    if (editor.editor.getNodes().some((n) => {
      const k = editor.kinds.get(n.id) ?? '';
      return isSpatialSourceKind(k) || isSpatialMasterKind(k);
    })) {
      try {
        await renderer.ensureWorkletLoaded();
      } catch (err) {
        console.warn('[crate-patcher] worklet did not load; spatial nodes will be passthrough', err);
      }
      if (token !== this.armToken) return;
    }
    for (const node of editor.editor.getNodes()) {
      if (!liveIds.has(node.id)) continue;
      const kind = editor.kinds.get(node.id) ?? '';
      if (isKeyboardKind(kind)) {
        const bank = createJacks(ctx);
        writeJacks(bank, snapshot, ctx.currentTime, false);
        this.jacks.set(node.id, bank);
        continue;
      }
      if (isMidiInKind(kind)) {
        const bank = createMidiInJacks(ctx);
        writeMidiInJacks(bank, undefined, ctx.currentTime, false);
        this.midiInJacks.set(node.id, bank);
        this.midiInMonitors.set(node.id, new MidiInputMonitor());
        pendingMidiIn.push(node.id);
        continue;
      }
      if (isMidiOutKind(kind)) {
        this.midiOuts.set(node.id, {
          state: createMidiOutputState(),
          fields: readMidiIoFields(editor.nodeData(node.id), DEFAULT_MIDI_OUT_FIELDS),
          output: null,
        });
        pendingMidiOut.push(node.id);
        continue;
      }
      if (isTransportKind(kind)) {
        const material = editor.materials.get(node.id);
        if (!material) continue;
        try {
          const live = await this.createLive(ctx, renderer, material, node.id);
          this.lives.set(node.id, live);
          this.transportJacks.set(node.id, createTransportJacks(ctx, live.mix));
        } catch (err) {
          console.warn(`[crate-patcher] transport ${node.id} fell back to scalar jacks`, err);
          const mix = ctx.createGain();
          mix.gain.value = 1;
          this.lives.set(node.id, { mix, handles: [], pool: null, kernelPoly: false });
          this.transportJacks.set(node.id, createTransportJacks(ctx, mix));
        }
        continue;
      }
      if (isMidiClipKind(kind)) continue;
      if (isMasterKind(kind)) continue;
      if (isLineKind(kind)) {
        pendingLines.push(node.id);
        continue;
      }
      const material = editor.materials.get(node.id);
      if (!material) continue;
      await this.attachLive(ctx, renderer, material, node.id, kind);
    }
    if (token !== this.armToken) return;
    this.unlock();
    await this.resumeIfNeeded();
    if (token !== this.armToken) return;
    this.rewire();
    if (this.speaker) {
      const dest = (this.scene!.audioContext as unknown as AudioContext).destination;
      attachNodeToHtmlSink(this.speaker, dest);
    }
    this.armSources();
    this.startTransport(editor, ctx);
    this.armSampleClips(editor, ctx);
    this.armMidiClips(editor, ctx);
    this.publishVoices();
    this.startMeter();
    this.playing = true;
    this.markKnownGraph(editor);
    const monitoredLines = pendingLines.filter((id) => lineMonitorOn(editor.nodeData(id)));
    void this.attachLines(ctx, monitoredLines, token);
    void this.attachMidiIo(pendingMidiIn, pendingMidiOut, token);
  }

  /**
   * Builds the live audio for one material node and files it under its id.
   *
   * Shared by arming a patch and by picking up a node that has only just
   * become audible, so the two cannot drift into building different things.
   * Some kinds are native Web Audio nodes rather than voices, which is why
   * this is a dispatch and not a call to `createLive`.
   */
  private async attachLive(
    ctx: AudioContext,
    renderer: WebAudioRenderer,
    material: AudioMaterial,
    nodeId: string,
    kind: string,
  ): Promise<void> {
    if (kind === 'sampleplayer') {
      this.lives.set(nodeId, this.createSampleLive(ctx, material));
      return;
    }
    if (kind === 'gain') {
      this.lives.set(nodeId, this.createMixerLive(createNativeGain(ctx, material.getParam('gain'))));
      return;
    }
    if (kind === 'stereopan') {
      this.lives.set(nodeId, this.createMixerLive(createNativeStereoPan(ctx, material.getParam('pan'))));
      return;
    }
    if (isSpatialSourceKind(kind) || isSpatialMasterKind(kind)) {
      try {
        const native = isSpatialSourceKind(kind)
          ? createSpatialSource(ctx, material)
          : createSpatialMaster(ctx, material);
        this.lives.set(nodeId, { ...this.createMixerLive(native), audioParams: native.audioParams, dispose: native.dispose });
      } catch (err) {
        console.warn(`[crate-patcher] spatial node ${nodeId} (${kind}) is passthrough`, err);
      }
      return;
    }
    try {
      this.lives.set(nodeId, await this.createLive(ctx, renderer, material, nodeId));
    } catch (err) {
      console.warn(`[crate-patcher] live node ${nodeId} (${kind}) fell back to passthrough`, err);
      const mix = ctx.createGain();
      mix.gain.value = 1;
      this.lives.set(nodeId, { mix, handles: [], pool: null, kernelPoly: false });
    }
    if (isAnalysisKind(kind)) {
      const live = this.lives.get(nodeId);
      if (live) this.analysisJacks.set(nodeId, createAnalysisJacks(ctx, kind, live.mix));
    }
    if (isLooperKind(kind)) {
      const live = this.lives.get(nodeId);
      if (live) this.looperJacks.set(nodeId, createLooperJacks(ctx, live.mix));
    }
  }

  private async attachLines(ctx: AudioContext, ids: readonly string[], token: number): Promise<void> {
    for (const id of ids) {
      const source = await this.lineSource(ctx, id);
      if (token !== this.armToken) return;
      if (source) this.lines.set(id, source);
    }
    if (this.playing && token === this.armToken && ids.length > 0) this.rewire();
  }

  private async ensureMidiAccess(): Promise<WebMidiAccessPorts | null> {
    if (this.midiAccess) return this.midiAccess;
    try {
      this.midiAccess = await requestMidiAccess();
      return this.midiAccess;
    } catch {
      return null;
    }
  }

  private async attachMidiIo(midiInIds: readonly string[], midiOutIds: readonly string[], token: number): Promise<void> {
    if (midiInIds.length === 0 && midiOutIds.length === 0) return;
    const access = await this.ensureMidiAccess();
    if (token !== this.armToken) return;
    for (const id of midiInIds) this.bindMidiIn(id, access);
    for (const id of midiOutIds) this.bindMidiOut(id, access);
  }

  private bindMidiIn(nodeId: string, access: WebMidiAccessPorts | null): void {
    const editor = this.editor;
    this.midiInUnsubs.get(nodeId)?.();
    this.midiInUnsubs.delete(nodeId);
    if (!editor || !access) return;
    const fields = readMidiIoFields(editor.nodeData(nodeId), DEFAULT_MIDI_IN_FIELDS);
    const input = findMidiInput(access, fields.deviceId);
    if (!input) return;
    const channel = midiInputChannel(fields.channel);
    const off = listenMidiInput(input, (data) => this.onMidiInBytes(nodeId, data, channel));
    this.midiInUnsubs.set(nodeId, off);
  }

  private bindMidiOut(nodeId: string, access: WebMidiAccessPorts | null): void {
    const editor = this.editor;
    if (!editor) return;
    const fields = readMidiIoFields(editor.nodeData(nodeId), DEFAULT_MIDI_OUT_FIELDS);
    let entry = this.midiOuts.get(nodeId);
    if (!entry) {
      entry = { state: createMidiOutputState(), fields, output: null };
      this.midiOuts.set(nodeId, entry);
    }
    if (entry.state.sounding != null && entry.output) {
      try {
        entry.output.send(encodeMidiVoiceEvent({ type: 'noteOff', note: entry.state.sounding }, entry.fields.channel));
      } catch {
        /* port gone */
      }
      entry.state.sounding = null;
    }
    entry.fields = fields;
    entry.output = access ? findMidiOutput(access, fields.deviceId) : null;
    entry.state.prevGate = false;
    entry.state.prevTrig = false;
    entry.state.offIn = null;
  }

  private onMidiInBytes(nodeId: string, data: Uint8Array, channel: number): void {
    const parsed = parseMidiBytes(data, channel);
    if (!parsed) return;
    const monitor = this.midiInMonitors.get(nodeId) ?? new MidiInputMonitor();
    this.midiInMonitors.set(nodeId, monitor);
    const voice = monitor.apply(parsed);
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    const bank = this.midiInJacks.get(nodeId);
    if (bank && ctx) writeMidiInJacks(bank, monitor.snapshot, ctx.currentTime, voice?.type === 'press');
    if (!voice || !this.playing || !this.editor) return;
    const event = analogFromMidi(voice.type, voice.note, voice.velocity, monitor.snapshot);
    for (const id of midiInNoteTargets(this.editor, nodeId)) {
      const live = this.lives.get(id);
      const material = this.editor.materials.get(id);
      if (!live || !material) continue;
      if (material.kind === 'drum' && event.type === 'press') {
        this.triggerDrumNative(live, material, event.note, event.velocity);
      }
      driveLive(live, material, event);
    }
  }

  private addMidiOutSourceIds(ids: Set<string>): void {
    const editor = this.editor;
    if (!editor) return;
    for (const conn of editor.editor.getConnections()) {
      if (isMidiOutKind(editor.kinds.get(conn.target) ?? '')) ids.add(conn.source);
    }
  }

  private stepMidiOutputs(dtSec: number): void {
    const editor = this.editor;
    if (!editor || this.midiOuts.size === 0) return;
    const cablesByNode = new Map<string, MidiOutputCables>();
    const sampleByNode = new Map<string, ReturnType<typeof emptyMidiSample>>();
    for (const conn of editor.editor.getConnections()) {
      if (!isMidiOutKind(editor.kinds.get(conn.target) ?? '')) continue;
      if (!(MIDI_OUT_INPUTS as readonly string[]).includes(conn.targetInput)) continue;
      const inlet = conn.targetInput as (typeof MIDI_OUT_INPUTS)[number];
      const cables = cablesByNode.get(conn.target) ?? emptyMidiCables();
      cables[inlet] = true;
      cablesByNode.set(conn.target, cables);
      // A one-sample pulse can be invisible in both mean and peak over a
      // block, so a latched edge is handed to crate as the reading's `pulse`
      // flag rather than being OR-ed in here. Whether gate and trig are edges
      // and everything else is a value is crate's rule (`midiOutSample`), not
      // this file's.
      const jack = jackFromOutputs(this.tapFrames.get(conn.source)?.outputs, conn.sourceOutput);
      const latched = this.midiPulseLatch.has(`${conn.source}:${conn.sourceOutput}`);
      const reading: MidiInletReading = {
        mean: jack?.mean ?? 0,
        peak: jack?.peak ?? 0,
        pulse: latched || jack?.pulse === true,
      };
      const sample = sampleByNode.get(conn.target) ?? emptyMidiSample();
      const one = midiOutSample({ ...emptyMidiCables(), [inlet]: true }, () => reading);
      sample[inlet] = one[inlet];
      sampleByNode.set(conn.target, sample);
    }
    this.midiPulseLatch.clear();
    for (const [id, entry] of this.midiOuts) {
      const cables = cablesByNode.get(id) ?? emptyMidiCables();
      const sample = sampleByNode.get(id) ?? emptyMidiSample();
      const events = stepMidiOutput(sample, cables, entry.fields, entry.state, dtSec);
      if (!entry.output) continue;
      for (const event of events) {
        try {
          entry.output.send(encodeMidiVoiceEvent(event, entry.fields.channel));
        } catch {
          /* port gone */
        }
      }
    }
  }

  private teardownMidiIo(): void {
    for (const off of this.midiInUnsubs.values()) off();
    this.midiInUnsubs.clear();
    this.midiInMonitors.clear();
    for (const entry of this.midiOuts.values()) {
      if (entry.state.sounding != null && entry.output) {
        try {
          entry.output.send(encodeMidiVoiceEvent({ type: 'noteOff', note: entry.state.sounding }, entry.fields.channel));
        } catch {
          /* port gone */
        }
      }
    }
    this.midiOuts.clear();
    this.midiPulseLatch.clear();
  }

  private async armTimeline(editor: PatchEditor, token: number): Promise<void> {
    const scene = this.scene!;
    const renderer = this.renderer!;
    const ctx = scene.audioContext as unknown as AudioContext;
    const stats = fillTimelineScene(scene, editorTimelineSource(editor));
    if (token !== this.armToken) return;
    this.unlock();
    await this.resumeIfNeeded();
    if (token !== this.armToken) return;
    try {
      await scene.prepareLiveVoices(renderer, await patcherKernelBinaries());
    } catch (err) {
      console.warn('[crate-patcher] live instruments failed; clips still play dry', err);
    }
    if (token !== this.armToken) return;
    const startSec = Math.max(0, editor.transport?.startSec ?? 0);
    if (scene.transport.state === 'playing') scene.transport.stop();
    scene.transport.seek(startSec);
    this.unlock();
    await this.resumeIfNeeded();
    if (token !== this.armToken) return;
    scene.transport.play();
    const start = scene.playback.lastStart;
    this.ensureMeterSink(ctx);
    this.timelinePlaying = true;
    await this.attachTimelineKernelInserts(editor, ctx, renderer, token);
    if (token !== this.armToken) return;
    if (this.speaker) {
      attachNodeToHtmlSink(this.speaker, ctx.destination);
    }
    const attached = this.attachTimelineGraph(editor, stats.bindings);
    await this.attachTimelineDrumLives(editor, ctx, renderer, stats.bindings, token);
    if (token !== this.armToken) return;
    const masterFader = start?.masterFader as GainNode | null | undefined;
    if (attached && masterFader) masterFader.gain.value = 0;
    this.armMidiClips(editor, ctx, 'drum');
    this.playing = true;
    this.markKnownGraph(editor);
    this.startMeter();
    console.info(
      `[crate-patcher] timeline play tracks=${stats.tracks} clips=${stats.clips} midi=${stats.midi} from ${startSec.toFixed(1)}s at ${scene.transport.bpm} bpm`,
    );
  }

  /**
   * Picks up nodes and cables added while Play is running.
   *
   * A drop used to sit on the canvas until Stop and Play, because arming
   * only builds voices once. Attach the new node, then rewire. No full
   * reinit: that would reopen the mic and restart the timeline.
   */
  sync(editor: PatchEditor): void {
    this.editor = editor;
    if (!this.playing) return;
    this.syncChain = this.syncChain
      .then(() => this.syncGraph())
      .catch((err) => {
        console.warn('[crate-patcher] graph sync failed', err);
      });
  }

  private async syncGraph(): Promise<void> {
    const editor = this.editor;
    if (!editor || !this.playing) return;
    const removed = this.forgetRemovedNodes(editor);
    const added = await this.adoptAddedNodes(editor);
    const audible = await this.adoptNewlyAudible(editor);
    if (this.timelinePlaying) this.ensureTimelineMixerLives();
    if (!this.rewire(removed || added || audible) && !removed && !added && !audible) return;
    this.lastCv.clear();
    this.publishVoices();
  }

  private markKnownGraph(editor: PatchEditor): void {
    this.knownGraphIds.clear();
    for (const node of editor.editor.getNodes()) this.knownGraphIds.add(node.id);
  }

  /**
   * Gives a voice to any node that has just become audible.
   *
   * Arming builds voices only for the nodes that reach Master, which is what
   * keeps a patch from paying for a disconnected corner of itself. Cabling
   * one of those into the output while Play is running used to reconnect
   * everything except the node that changed: it had no voice, so there was
   * nothing to connect, and it stayed silent until the next Stop and Play
   * with no indication why.
   *
   * Only additions. A node that stops reaching Master keeps its voice, since
   * cables move constantly while patching and rebuilding on every
   * disconnection would cost more than the voice does.
   */
  private async adoptNewlyAudible(editor: PatchEditor): Promise<boolean> {
    const renderer = this.renderer;
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!renderer || !ctx) return false;
    const reachable = liveNodeIds(
      editor.editor.getNodes().map((node) => ({ id: node.id, kind: editor.kinds.get(node.id) ?? '' })),
      editor.editor.getConnections().map((conn) => ({ source: conn.source, target: conn.target })),
    );
    let added = false;
    for (const id of reachable) {
      if (this.lives.has(id)) continue;
      const kind = editor.kinds.get(id) ?? '';
      if (isKeyboardKind(kind) || isMidiInKind(kind) || isMidiOutKind(kind)) continue;
      if (isMidiClipKind(kind) || isMasterKind(kind) || isLineKind(kind) || isTransportKind(kind)) continue;
      const material = editor.materials.get(id);
      if (!material) continue;
      await this.attachLive(ctx, renderer, material, id, kind);
      this.armNewSource(id);
      added = true;
    }
    return added;
  }

  /** Nodes dropped after Play, even before they are cabled to Master. */
  private async adoptAddedNodes(editor: PatchEditor): Promise<boolean> {
    let added = false;
    for (const node of editor.editor.getNodes()) {
      if (this.knownGraphIds.has(node.id)) continue;
      const kind = editor.kinds.get(node.id) ?? '';
      if (!kind) continue;
      this.knownGraphIds.add(node.id);
      await this.attachGraphNode(editor, node.id, kind);
      added = true;
    }
    return added;
  }

  private forgetRemovedNodes(editor: PatchEditor): boolean {
    const current = new Set(editor.editor.getNodes().map((node) => node.id));
    let removed = false;
    for (const id of [...this.knownGraphIds]) {
      if (current.has(id)) continue;
      this.knownGraphIds.delete(id);
      this.disposeGraphNode(id);
      removed = true;
    }
    return removed;
  }

  private async attachGraphNode(editor: PatchEditor, nodeId: string, kind: string): Promise<void> {
    const renderer = this.renderer;
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!renderer || !ctx) return;
    if (isMasterKind(kind) || isMidiClipKind(kind)) return;
    if (isKeyboardKind(kind)) {
      if (this.jacks.has(nodeId)) return;
      const bank = createJacks(ctx);
      writeJacks(bank, this.analog?.snapshot, ctx.currentTime, false);
      this.jacks.set(nodeId, bank);
      return;
    }
    if (isMidiInKind(kind)) {
      if (this.midiInJacks.has(nodeId)) return;
      const bank = createMidiInJacks(ctx);
      writeMidiInJacks(bank, undefined, ctx.currentTime, false);
      this.midiInJacks.set(nodeId, bank);
      this.midiInMonitors.set(nodeId, new MidiInputMonitor());
      void this.attachMidiIo([nodeId], [], this.armToken);
      return;
    }
    if (isMidiOutKind(kind)) {
      if (this.midiOuts.has(nodeId)) return;
      this.midiOuts.set(nodeId, {
        state: createMidiOutputState(),
        fields: readMidiIoFields(editor.nodeData(nodeId), DEFAULT_MIDI_OUT_FIELDS),
        output: null,
      });
      void this.attachMidiIo([], [nodeId], this.armToken);
      return;
    }
    if (isLineKind(kind)) {
      if (this.lines.has(nodeId) || !lineMonitorOn(editor.nodeData(nodeId))) return;
      void this.attachLines(ctx, [nodeId], this.armToken);
      return;
    }
    if (this.lives.has(nodeId)) return;
    const material = editor.materials.get(nodeId);
    if (!material) return;
    if (isTransportKind(kind)) {
      try {
        const live = await this.createLive(ctx, renderer, material, nodeId);
        this.lives.set(nodeId, live);
        this.transportJacks.set(nodeId, createTransportJacks(ctx, live.mix));
      } catch (err) {
        console.warn(`[crate-patcher] transport ${nodeId} fell back to scalar jacks`, err);
        const mix = ctx.createGain();
        mix.gain.value = 1;
        this.lives.set(nodeId, { mix, handles: [], pool: null, kernelPoly: false });
        this.transportJacks.set(nodeId, createTransportJacks(ctx, mix));
      }
      this.startTransport(editor, ctx);
      return;
    }
    await this.attachLive(ctx, renderer, material, nodeId, kind);
    this.armNewSource(nodeId);
  }

  private disposeGraphNode(nodeId: string): void {
    const live = this.lives.get(nodeId);
    if (live) {
      live.pool?.allNotesOff();
      for (const handle of live.handles) disposeVoiceHandle(handle);
      try {
        live.mix.disconnect();
      } catch {
        /* already gone */
      }
      if (live.input && live.input !== live.mix) {
        try {
          live.input.disconnect();
        } catch {
          /* already gone */
        }
      }
      live.dispose?.();
      this.lives.delete(nodeId);
    }
    const keys = this.jacks.get(nodeId);
    if (keys) {
      for (const node of Object.values(keys)) {
        try {
          node.stop();
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
      this.jacks.delete(nodeId);
    }
    const midiIn = this.midiInJacks.get(nodeId);
    if (midiIn) {
      for (const node of Object.values(midiIn)) {
        try {
          node.stop();
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
      this.midiInJacks.delete(nodeId);
    }
    this.midiInUnsubs.get(nodeId)?.();
    this.midiInUnsubs.delete(nodeId);
    this.midiInMonitors.delete(nodeId);
    const midiOut = this.midiOuts.get(nodeId);
    if (midiOut) {
      if (midiOut.state.sounding != null && midiOut.output) {
        try {
          midiOut.output.send(
            encodeMidiVoiceEvent({ type: 'noteOff', note: midiOut.state.sounding }, midiOut.fields.channel),
          );
        } catch {
          /* port gone */
        }
      }
      this.midiOuts.delete(nodeId);
    }
    const line = this.lines.get(nodeId);
    if (line) {
      try {
        line.gain.disconnect();
        line.source.disconnect();
      } catch {
        /* already gone */
      }
      this.lines.delete(nodeId);
      if (this.lines.size === 0) {
        this.lineOpen?.close();
        this.lineOpen = null;
      }
    }
    const transport = this.transportJacks.get(nodeId);
    if (transport) {
      stopTransportScalars(transport);
      this.transportJacks.delete(nodeId);
    }
    const analysis = this.analysisJacks.get(nodeId);
    if (analysis) {
      stopAnalysisScalars(analysis);
      this.analysisJacks.delete(nodeId);
    }
    const looper = this.looperJacks.get(nodeId);
    if (looper) {
      stopLooperScalars(looper);
      this.looperJacks.delete(nodeId);
    }
  }

  private armNewSource(id: string): void {
    const editor = this.editor;
    if (!editor) return;
    const live = this.lives.get(id);
    const material = editor.materials.get(id);
    if (!live || !material) return;
    const keyed = new Set([...keyedTargets(editor), ...midiInNoteTargets(editor)]);
    if (keyed.has(id)) return;
    if (material.audioInputs.length === 0 && !controlInputs(material).includes('note')) {
      live.handles[0]?.noteOn({ ...material.snapshotParams(), note: 69, velocity: 0.85 });
    }
  }

  setLineMonitor(nodeId: string, on: boolean): void {
    const line = this.lines.get(nodeId);
    if (line) {
      line.gain.gain.value = on ? 1 : 0;
      return;
    }
    if (!on || !this.playing) return;
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!ctx) return;
    const token = this.armToken;
    void this.attachLines(ctx, [nodeId], token).then(() => {
      const opened = this.lines.get(nodeId);
      if (opened) opened.gain.gain.value = 1;
    });
  }

  /**
   * Chooses the capture device for every Line node. Device ids are host
   * local: not written into crate.patch, not sent to a session. A change
   * while Play is running reopens the stream and rewires; otherwise Play
   * picks it up.
   */
  get lineOpenedLabel(): string | null {
    const label = this.lineOpen?.label;
    return label ? label : null;
  }

  async setLineDevice(deviceId: string | null): Promise<string | null> {
    const next = normalizeLineDeviceId(deviceId);
    const same = next === this.lineDeviceId;
    this.lineDeviceId = next;
    this.lineOpenError = null;
    if (!this.playing || !this.editor) return this.lineDeviceId;
    if (same && this.lineOpen) return this.lineDeviceId;
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!ctx) return this.lineDeviceId;
    const token = this.armToken;
    const ids = this.liveLineIds();
    this.teardownLines();
    if (token !== this.armToken) return this.lineDeviceId;
    await this.attachLines(ctx, ids, token);
    if (ids.length > 0 && this.lineDeviceId && !this.lineOpen) {
      throw new Error(
        this.lineOpenError ??
          'The selected input did not open. Chrome on Android lists USB audio but often still captures the phone microphone.',
      );
    }
    return this.lineDeviceId;
  }

  setMasterMonitor(on: boolean): void {
    this.masterMonitor = on;
    if (this.speaker) this.speaker.gain.value = on ? 1 : 0;
  }

  /**
   * Re-opens this node's MIDI port after inspector device or channel changes.
   * Device id is this machine's and is not networked. Empty deviceId means
   * the first available port.
   */
  async syncMidiIo(nodeId: string): Promise<void> {
    if (!this.playing || !this.editor) return;
    const kind = this.editor.kinds.get(nodeId) ?? '';
    if (!isMidiInKind(kind) && !isMidiOutKind(kind)) return;
    const access = await this.ensureMidiAccess();
    if (isMidiInKind(kind)) this.bindMidiIn(nodeId, access);
    if (isMidiOutKind(kind)) this.bindMidiOut(nodeId, access);
  }

  setParam(nodeId: string, name: string, value: number): void {
    const live = this.lives.get(nodeId);
    if (live) {
      if (live.nativeSetParam) {
        live.nativeSetParam(name, value);
      } else if (live.pool) {
        live.pool.setParam(name, value);
      } else {
        for (const handle of live.handles) handle.setParam(name, value);
      }
    }
    if (this.editor && isTransportKind(this.editor.kinds.get(nodeId) ?? '')) {
      this.editor.syncTransportFromGraph();
      this.publishTransportAnchor();
    }
  }

  /**
   * Re-binds a node's kernels after a NAM or IR file change. bindLiveVoice
   * is the same path Play already uses, so a profile swap mid-take does not
   * need a Stop.
   */
  async refreshKernels(nodeId: string): Promise<void> {
    if (!this.playing) return;
    const material = this.editor?.materials.get(nodeId);
    const live = this.lives.get(nodeId);
    if (!material || !live) return;
    const plugin = audioMaterialRegistry.forMaterial(material);
    if (!plugin?.bindLiveVoice) return;
    const wasm = await patcherKernelBinaries();
    for (const handle of live.handles) {
      await plugin.bindLiveVoice(handle, material, wasm);
    }
  }

  /**
   * Plays one note on one node, and on nothing else.
   *
   * An instrument's own control surface is not a second keybed. The pad grid
   * belongs to the drum it is drawn for, so it addresses that node's voices
   * directly; routing it through the analog keyboard would send every pad hit
   * to whatever the Keyboard node happens to be cabled to, which is some
   * other instrument, and would light the keybed as though someone had played
   * it. Nothing here touches `keyedTargets`, the keyboard snapshot, or the cv
   * and gate jacks.
   */
  triggerNode(nodeId: string, note: number, velocity = 1): boolean {
    const live = this.lives.get(nodeId);
    const material = this.editor?.materials.get(nodeId);
    // A node gets a voice at Play, or when it is dropped while Play is
    // running. No voice here means arming has not reached it yet.
    if (!live || !material) return false;
    if (material.kind === 'drum') {
      const heard = this.triggerDrumNative(live, material, note, velocity);
      const handle = live.handles[0];
      if (handle) handle.noteOn({ ...material.snapshotParams(), note: drumLiveNote(note), velocity });
      return heard;
    }
    const playNote = note;
    const handle = live.handles[0];
    if (!handle && !live.pool) return false;
    if (live.kernelPoly && handle) {
      handle.midiNoteOn(playNote, velocity);
      return true;
    }
    if (live.pool) {
      live.pool.noteOn(playNote, { velocity });
      return true;
    }
    if (!handle) return false;
    handle.noteOn({ ...material.snapshotParams(), note: playNote, velocity });
    return true;
  }

  /**
   * Releases a note this node was playing.
   *
   * A drum pad is a one-shot and plays on past this; the gate still has to
   * fall, because the next press on the same pad is an edge and there is no
   * edge without one.
   */
  releaseNode(nodeId: string, note: number): void {
    const live = this.lives.get(nodeId);
    if (!live) return;
    if ((this.editor?.kinds.get(nodeId) ?? '') === 'drum') return;
    const handle = live.handles[0];
    if (live.kernelPoly && handle) {
      handle.midiNoteOff(note);
      return;
    }
    if (live.pool) {
      live.pool.noteOff(note);
      return;
    }
    handle?.noteOff();
  }

  /**
   * Rebuilds one node's voices from its current graph.
   *
   * A sample is part of the graph, not a message: `samplePlay` reads the
   * buffer that was in its box when the voice was created, and the worklet
   * has held its own copy ever since. Loading a kit into a drum that is
   * already playing therefore needs the voices built again.
   * `refreshKernels` is the cheaper path for a NAM or an IR and does not
   * apply here, because a pure-ASL instrument has no kernel to rebind.
   */
  async reloadVoice(nodeId: string): Promise<void> {
    if (!this.playing) return;
    const editor = this.editor;
    const renderer = this.renderer;
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    const material = editor?.materials.get(nodeId);
    const previous = this.lives.get(nodeId);
    if (!editor || !renderer || !ctx || !material || !previous) return;
    for (const handle of previous.handles) disposeVoiceHandle(handle);
    try {
      previous.mix.disconnect();
    } catch {
      /* already gone */
    }
    previous.dispose?.();
    const kind = editor.kinds.get(nodeId) ?? '';
    await this.attachLive(ctx, renderer, material, nodeId, kind);
    this.rewire(true);
    this.publishVoices();
  }

  stop(): void {
    this.armToken += 1;
    this.arming = false;
    setWebAudioWantRunning(false);
    this.stopVoices();
    this.playing = false;
    this.wireSig = '';
    activityBus.clear();
    analysisBus.clear();
  }

  private async resumeIfNeeded(): Promise<void> {
    const ctx = (this.scene?.audioContext ?? getSharedWebAudioContext()) as AudioContext;
    this.unlock();
    if (ctx.state !== 'running') await ctx.resume();
  }

  private connectionSig(): string {
    const editor = this.editor;
    if (!editor) return '';
    const cables = editor.editor
      .getConnections()
      .map((conn) => `${conn.source}:${conn.sourceOutput}>${conn.target}:${conn.targetInput}`)
      .sort()
      .join('|');
    return `${cables}#L${this.lives.size}N${this.lines.size}J${this.jacks.size}M${this.midiInJacks.size}O${this.midiOuts.size}T${this.transportJacks.size}A${this.analysisJacks.size}P${this.looperJacks.size}`;
  }

  private rewire(force = true): boolean {
    const editor = this.editor;
    const master = this.master;
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!editor || !master || !ctx) return false;
    const sig = this.connectionSig();
    if (!force && sig === this.wireSig) return false;
    this.wireSig = sig;
    for (const live of this.lives.values()) {
      try {
        live.mix.disconnect();
      } catch {
        /* already gone */
      }
      for (const handle of live.handles) {
        try {
          handle.node.disconnect();
        } catch {
          /* already gone */
        }
      }
    }
    for (const bank of this.jacks.values()) {
      for (const node of Object.values(bank)) {
        try {
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
    }
    for (const bank of this.midiInJacks.values()) {
      for (const node of Object.values(bank)) {
        try {
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
    }
    for (const bank of this.transportJacks.values()) {
      disconnectTransportScalars(bank);
    }
    for (const bank of this.analysisJacks.values()) {
      disconnectAnalysisScalars(bank);
    }
    for (const bank of this.looperJacks.values()) {
      disconnectLooperScalars(bank);
    }
    for (const line of this.lines.values()) {
      try {
        line.gain.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.clearTaps();
    const fft = this.timelinePlaying ? 512 : 256;
    const sink = this.timelinePlaying ? this.meterSink : null;
    const tapsByNode = new Map<AudioNode, Tap>();
    const tapFor = (node: AudioNode): Tap => {
      const hit = tapsByNode.get(node);
      if (hit) return hit;
      const tap = makeTap(ctx, node, sink, fft);
      tapsByNode.set(node, tap);
      return tap;
    };
    this.taps.set('__master', tapFor(master));

    const wired: Array<{ from: AudioNode; to: AudioNode; output: number; input: number }> = [];
    const wiredParams: Array<{ from: AudioNode; to: AudioParam }> = [];
    const connectOnce = (from: AudioNode, to: AudioNode, output = 0, input = 0): void => {
      if (wired.some((wire) => wire.from === from && wire.to === to && wire.output === output && wire.input === input)) {
        return;
      }
      wired.push({ from, to, output, input });
      if (output === 0 && input === 0) from.connect(to);
      else from.connect(to, output, input);
    };

    for (const conn of editor.editor.getConnections()) {
      const from = this.sourceNode(conn.source, conn.sourceOutput);
      const material = editor.materials.get(conn.target);
      if (isMasterKind(editor.kinds.get(conn.target) ?? '')) {
        if (from && conn.targetInput === 'input') connectOnce(from, master);
        continue;
      }
      if (!from) continue;
      // A param backed by a real AudioParam takes the cable directly, at
      // audio rate. `applyCv` skips these, so the modulation is applied once.
      const audioParam = this.lives.get(conn.target)?.audioParams?.[conn.targetInput];
      if (audioParam && material && isCvInlet(material, conn.targetInput)) {
        if (!wiredParams.some((wire) => wire.from === from && wire.to === audioParam)) {
          wiredParams.push({ from, to: audioParam });
          try {
            from.connect(audioParam);
          } catch {
            /* a source that cannot drive a param stays on the meter path */
          }
        }
        continue;
      }
      if (material && isAudioInlet(material, conn.targetInput)) {
        const to = this.lives.get(conn.target);
        if (!to) continue;
        const port = to.handles[0];
        const inlet = to.input ?? to.mix;
        try {
          if (port) connectOnce(from, port.node, 0, port.inputIndexFor(conn.targetInput));
          else connectOnce(from, inlet);
        } catch {
          connectOnce(from, inlet);
        }
      }
    }

    for (const [id, live] of this.lives) {
      for (const handle of live.handles) handle.node.connect(live.mix);
      if (isTransportKind(editor.kinds.get(id) ?? '')) {
        const bank = this.transportJacks.get(id);
        if (!bank) continue;
        for (const name of TRANSPORT_OUTPUTS) {
          this.taps.set(`${id}:${name}`, tapFor(transportJackNode(bank, name)));
        }
        continue;
      }
      const analysis = this.analysisJacks.get(id);
      if (analysis) {
        for (const name of tapOutputNames(editor.materials.get(id))) {
          this.taps.set(`${id}:${name}`, tapFor(analysisJackNode(analysis, name)));
        }
        continue;
      }
      const looperBank = this.looperJacks.get(id);
      if (looperBank) {
        for (const name of LOOPER_OUTPUTS) {
          this.taps.set(`${id}:${name}`, tapFor(looperJackNode(looperBank, name)));
        }
        continue;
      }
      const tapNode = live.handles[0]?.node ?? live.mix;
      const tap = tapFor(tapNode);
      for (const name of tapOutputNames(editor.materials.get(id))) this.taps.set(`${id}:${name}`, tap);
    }
    for (const [id, bank] of this.jacks) {
      for (const name of KEYBOARD_OUTPUTS) this.taps.set(`${id}:${name}`, tapFor(bank[name]));
    }
    for (const [id, bank] of this.midiInJacks) {
      for (const name of MIDI_IN_OUTPUTS) this.taps.set(`${id}:${name}`, tapFor(bank[name]));
    }
    for (const [id, line] of this.lines) this.taps.set(`${id}:audio`, tapFor(line.gain));
    return true;
  }

  /**
   * Grain is an insert, not a track instrument. Bind its kernel on the
   * timeline so it sits on the clip mix instead of replacing it.
   */
  private async attachTimelineKernelInserts(
    editor: PatchEditor,
    ctx: AudioContext,
    renderer: WebAudioRenderer,
    token: number,
  ): Promise<void> {
    for (const node of editor.editor.getNodes()) {
      if (token !== this.armToken) return;
      if (this.lives.has(node.id)) continue;
      const kind = editor.kinds.get(node.id) ?? '';
      if (kind !== 'grain') continue;
      const material = editor.materials.get(node.id);
      if (!material || material.audioInputs.length === 0) continue;
      try {
        this.lives.set(node.id, await this.createLive(ctx, renderer, material, node.id));
      } catch (err) {
        console.warn(`[crate-patcher] grain insert ${node.id} fell back to passthrough`, err);
      }
    }
  }

  /**
   * Pull clip mixes and instruments off the DAW fader and into the visible
   * graph. Several sample players on one lane share one clip mix; connecting
   * that node once per cable would double the track.
   */
  private attachTimelineGraph(
    editor: PatchEditor,
    bindings: Array<{ trackId: number; lane: TimelineLane }>,
  ): boolean {
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!ctx || !this.master) return false;
    const start = this.scene?.playback.lastStart ?? null;
    const voices = this.scene?.preparedLiveVoices ?? null;
    let attached = false;
    for (const { trackId, lane } of bindings) {
      const clipGain = start?.clipGainTargets.get(trackId) as GainNode | undefined;
      if (clipGain && typeof clipGain.disconnect === 'function' && lane.sampleIds.length > 0) {
        try {
          clipGain.disconnect();
        } catch {
          /* already dry */
        }
        for (const id of lane.sampleIds) {
          this.lives.set(id, { mix: clipGain, handles: [], pool: null, kernelPoly: false });
        }
        attached = true;
      }
      const instrument = voices?.tracks.get(trackId)?.instrument;
      if (instrument && lane.instId) {
        const mix = ctx.createGain();
        mix.gain.value = 1;
        try {
          instrument.node.disconnect();
        } catch {
          /* already dry */
        }
        this.lives.set(lane.instId, { mix, handles: [instrument], pool: null, kernelPoly: true });
        attached = true;
      }
    }
    this.ensureTimelineMixerLives(editor);
    this.rewire();
    return attached;
  }

  private async attachTimelineDrumLives(
    editor: PatchEditor,
    ctx: AudioContext,
    renderer: WebAudioRenderer,
    bindings: Array<{ trackId: number; lane: TimelineLane }>,
    token: number,
  ): Promise<void> {
    let added = false;
    for (const { lane } of bindings) {
      if (token !== this.armToken) return;
      if (!lane.instId || (editor.kinds.get(lane.instId) ?? '') !== 'drum') continue;
      if (this.lives.get(lane.instId)?.handles[0]) continue;
      const material = editor.materials.get(lane.instId);
      if (!material) continue;
      try {
        this.lives.set(lane.instId, await this.createLive(ctx, renderer, material, lane.instId));
        added = true;
      } catch (err) {
        console.warn(`[crate-patcher] drum ${lane.instId} fell back to silence`, err);
      }
    }
    if (added) this.rewire();
  }

  private ensureTimelineMixerLives(editor: PatchEditor | null = this.editor): void {
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!editor || !ctx) return;
    for (const node of editor.editor.getNodes()) {
      if (this.lives.has(node.id)) continue;
      const kind = editor.kinds.get(node.id) ?? '';
      if (isMasterKind(kind) || isMidiClipKind(kind) || isKeyboardKind(kind) || isLineKind(kind) || isTransportKind(kind) || isMidiInKind(kind) || isMidiOutKind(kind)) continue;
      if (kind === 'sampleplayer' || kind === 'synth' || kind === 'drum') continue;
      const material = editor.materials.get(node.id);
      if (kind === 'gain') {
        this.lives.set(node.id, this.createMixerLive(createNativeGain(ctx, material?.getParam('gain') ?? 1)));
        continue;
      }
      if (kind === 'stereopan') {
        this.lives.set(node.id, this.createMixerLive(createNativeStereoPan(ctx, material?.getParam('pan') ?? 0)));
        continue;
      }
      if (isSpatialSourceKind(kind) || isSpatialMasterKind(kind)) {
        try {
          const native = isSpatialSourceKind(kind)
            ? createSpatialSource(ctx, material)
            : createSpatialMaster(ctx, material);
          this.lives.set(node.id, { ...this.createMixerLive(native), audioParams: native.audioParams, dispose: native.dispose });
        } catch {
          /* the worklet is not loaded on this path; Play builds it properly */
        }
        continue;
      }
      if (!material || material.audioInputs.length === 0) continue;
      const mix = ctx.createGain();
      mix.gain.value = 1;
      this.lives.set(node.id, { mix, input: mix, handles: [], pool: null, kernelPoly: false });
    }
  }

  private sourceNode(id: string, output: string): AudioNode | undefined {
    if (this.jacks.has(id) && isKeyboardOut(output)) return this.jacks.get(id)?.[output];
    const midiIn = this.midiInJacks.get(id);
    if (midiIn && isMidiInOutput(output)) return midiIn[output];
    if (this.lines.has(id) && output === 'audio') return this.lines.get(id)?.gain;
    const transport = this.transportJacks.get(id);
    if (transport && isTransportKind(this.editor?.kinds.get(id) ?? '')) {
      return transportJackNode(transport, output);
    }
    const analysis = this.analysisJacks.get(id);
    if (analysis) return analysisJackNode(analysis, output);
    const looperBank = this.looperJacks.get(id);
    if (looperBank) return looperJackNode(looperBank, output);
    return this.lives.get(id)?.mix;
  }

  private liveLineIds(): string[] {
    const editor = this.editor;
    if (!editor) return [];
    const liveIds = liveNodeIds(
      editor.editor.getNodes().map((node) => ({ id: node.id, kind: editor.kinds.get(node.id) ?? '' })),
      editor.editor.getConnections().map((conn) => ({ source: conn.source, target: conn.target })),
    );
    return editor.editor
      .getNodes()
      .filter((node) => liveIds.has(node.id) && isLineKind(editor.kinds.get(node.id) ?? ''))
      .map((node) => node.id);
  }

  private teardownLines(): void {
    for (const line of this.lines.values()) {
      try {
        line.gain.disconnect();
        line.source.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.lines.clear();
    this.lineOpen?.close();
    this.lineOpen = null;
  }

  private async ensureLineOpen(ctx: AudioContext): Promise<OpenInputResult | null> {
    if (this.lineOpen) return this.lineOpen;
    this.lineOpenError = null;
    try {
      this.lineOpen = await openInput(ctx, this.lineDeviceId);
      await this.resumeIfNeeded();
      return this.lineOpen;
    } catch (err) {
      // Do not open the built-in mic after a named device failed. That is how
      // the picker stayed on "USB audio" while Android Chrome captured the
      // phone microphone.
      this.lineOpenError = err instanceof Error ? err.message : String(err);
      if (this.lineDeviceId) {
        console.warn('[crate-patcher] selected line input did not open', err);
      }
      return null;
    }
  }

  private async lineSource(ctx: AudioContext, nodeId: string): Promise<{ source: AudioNode; gain: GainNode } | null> {
    const opened = await this.ensureLineOpen(ctx);
    if (!opened) return null;
    const gain = ctx.createGain();
    gain.gain.value = lineMonitorOn(this.editor?.nodeData(nodeId)) ? 1 : 0;
    opened.node.connect(gain);
    return { source: opened.node, gain };
  }

  private onAnalog(event: AnalogEvent): void {
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    // Unlock the context that exists; do not bring one into existence. This
    // used to call `unlock()` first, so a stray key event on a patch that had
    // never been started built an AudioContext, and a context that exists is
    // one the browser keeps asking the output device to open. The gesture
    // path that genuinely needs to unlock in the same turn (App's
    // `fingerDown`, then `play`) already does it itself.
    if (ctx) this.unlock();
    const now = ctx?.currentTime ?? 0;
    for (const bank of this.jacks.values()) {
      if (ctx) writeJacks(bank, event.snapshot, now, event.type === 'press');
    }
    if (!this.playing || !this.editor) return;
    for (const id of keyedTargets(this.editor)) {
      const live = this.lives.get(id);
      const material = this.editor.materials.get(id);
      if (!live || !material) continue;
      if (material.kind === 'drum' && event.type === 'press') {
        this.triggerDrumNative(live, material, event.note, event.velocity);
      }
      driveLive(live, material, event);
    }
    this.publishVoices();
  }

  /**
   * The meter loop.
   *
   * Live patches split two jobs on one rAF: lighting jacks at
   * `METER_INTERVAL_MS`, and driving CV every frame from only the nodes a
   * cable reads. Timeline Play has no CV job, so it sleeps at
   * `METER_SLOW_MS` while peaks stay below `METER_WAKE_PEAK`, then runs rAF
   * until a quiet stretch past `METER_SLEEP_AFTER_MS`. Quiet ticks still
   * read analysers so a hit can wake the loop; they skip cable paint.
   */
  private startMeter(): void {
    this.stopMeterLoop();
    this.meterFast = true;
    this.meterQuietMs = 0;
    this.lastMeterTick = 0;
    this.lastMeter = 0;
    this.lastMidiOutMs = 0;
    if (this.timelinePlaying) this.meterTick(performance.now());
    else this.scheduleMeter(true);
  }

  private stopMeterLoop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.meterTimer) {
      window.clearTimeout(this.meterTimer);
      this.meterTimer = 0;
    }
  }

  private scheduleMeter(fast: boolean): void {
    this.stopMeterLoop();
    if (!this.playing) return;
    if (fast) this.raf = requestAnimationFrame((now) => this.meterTick(now));
    else this.meterTimer = window.setTimeout(() => this.meterTick(performance.now()), METER_SLOW_MS);
  }

  private meterTick(now: number): void {
    if (!this.playing) return;
    this.writeTransportJacks();
    this.writeAnalysisJacks();
    if (this.timelinePlaying) {
      this.tickTimelineMeters(now);
      return;
    }
    const publish = now - this.lastMeter >= METER_INTERVAL_MS;
    if (publish) this.lastMeter = now;
    const only = publish ? null : this.cvSourceIds();
    if (only) this.addMidiOutSourceIds(only);
    this.sampleActivity(publish, only);
    this.applyCv();
    const dtSec = this.lastMidiOutMs > 0 ? Math.max(0, (now - this.lastMidiOutMs) / 1000) : METER_INTERVAL_MS / 1000;
    this.lastMidiOutMs = now;
    this.stepMidiOutputs(dtSec);
    this.scheduleMeter(true);
  }

  /**
   * The nodes a CV cable reads from, reusing one set so a frame costs no
   * allocation. Recomputed each frame rather than cached against an editor
   * event, because a walk of the connection list is far cheaper than one
   * analyser read and cannot go stale.
   */
  private cvSourceIds(): Set<string> {
    const editor = this.editor;
    const ids = this.cvSources;
    ids.clear();
    if (!editor) return ids;
    for (const conn of editor.editor.getConnections()) {
      const material = editor.materials.get(conn.target);
      if (material && isCvInlet(material, conn.targetInput)) ids.add(conn.source);
    }
    return ids;
  }

  /** `only` limits the pass to those node ids; null reads everything. */
  private sampleActivity(publish: boolean, only: Set<string> | null): void {
    this.readTapFrames(only);
    if (publish) this.publishTapFrames();
  }

  private readTapFrames(only: Set<string> | null): void {
    const editor = this.editor;
    if (!editor) return;
    if (only && only.size === 0) return;
    const byNode = new Map<string, NodeActivity>();
    const take = (id: string): NodeActivity => {
      let frame = byNode.get(id);
      if (!frame) {
        frame = { outputs: {}, inputs: {} };
        byNode.set(id, frame);
      }
      return frame;
    };
    const now = performance.now();
    const jackOf = (tap: Tap): JackActivity =>
      this.timelinePlaying ? this.readHeldTap(tap, now) : readAnalyser(tap.analyser, tap.buffer, tap.wave);
    for (const [key, tap] of this.taps) {
      if (key === '__master') {
        if (only) continue;
        take('__master').inputs.input = jackOf(tap);
        continue;
      }
      const sep = key.lastIndexOf(':');
      const id = key.slice(0, sep);
      if (only && !only.has(id)) continue;
      const jack = key.slice(sep + 1);
      take(id).outputs[jack] = jackOf(tap);
    }
    this.tapFrames = byNode;
  }

  private spreadTapFrames(): void {
    const editor = this.editor;
    if (!editor) return;
    overlaySpread(
      this.tapFrames,
      editor.editor.getConnections().map((conn) => ({
        source: conn.source,
        sourceOutput: conn.sourceOutput,
        target: conn.target,
        targetInput: conn.targetInput,
      })),
    );
  }

  private publishTapFrames(): void {
    const editor = this.editor;
    if (!editor) return;
    const byNode = this.tapFrames;
    const take = (id: string): NodeActivity => {
      let frame = byNode.get(id);
      if (!frame) {
        frame = { outputs: {}, inputs: {} };
        byNode.set(id, frame);
      }
      return frame;
    };
    for (const conn of editor.editor.getConnections()) {
      const source = jackFromOutputs(byNode.get(conn.source)?.outputs, conn.sourceOutput);
      if (source.peak === 0 && source.mean === 0 && source.rms === 0) continue;
      take(conn.target).inputs[conn.targetInput] = source;
    }
    const frames = new Map(byNode);
    for (const node of editor.editor.getNodes()) {
      if (!frames.has(node.id)) frames.set(node.id, { outputs: {}, inputs: {} });
    }
    activityBus.publish(frames, this.timelinePlaying);
  }

  private meterPeakFromFrames(): number {
    let peak = 0;
    for (const frame of this.tapFrames.values()) {
      const jack = loudestJack(frame);
      if (jack && jack.peak > peak) peak = jack.peak;
    }
    return peak;
  }

  private tickTimelineMeters(now: number): void {
    const dtMs = this.lastMeterTick > 0 ? now - this.lastMeterTick : METER_SLOW_MS;
    this.lastMeterTick = now;
    this.readTapFrames(null);
    this.spreadTapFrames();
    const peak = this.meterPeakFromFrames();
    const next = meterRefresh({
      fast: this.meterFast,
      peak,
      quietMs: this.meterQuietMs,
      dtMs,
    });
    const goingQuiet = this.meterFast && !next.fast;
    if (next.fast || goingQuiet || peak > 0.02) this.publishTapFrames();
    this.meterFast = next.fast;
    this.meterQuietMs = next.quietMs;
    this.scheduleMeter(next.fast);
  }

  private readHeldTap(tap: Tap, now: number): JackActivity {
    const instant = readAnalyser(tap.analyser, tap.buffer, tap.wave);
    const dtSec = tap.lastMs > 0 ? Math.max(0, (now - tap.lastMs) / 1000) : 0;
    tap.lastMs = now;
    tap.heldPeak = holdPeak(tap.heldPeak, instant.peak, dtSec);
    return {
      ...instant,
      peak: tap.heldPeak,
      pulse: tap.heldPeak > 0.04,
    };
  }

  private ensureMeterSink(ctx: AudioContext): GainNode {
    if (this.meterSink) return this.meterSink;
    const sink = ctx.createGain();
    sink.gain.value = 0.0001;
    sink.connect(ctx.destination);
    this.meterSink = sink;
    return sink;
  }

  private applyCv(): void {
    const editor = this.editor;
    if (!editor) return;
    for (const conn of editor.editor.getConnections()) {
      const material = editor.materials.get(conn.target);
      if (!material) continue;
      const sourceKind = editor.kinds.get(conn.source) ?? '';
      const fromAnalysis = isAnalysisKind(sourceKind) && conn.sourceOutput !== 'audio';
      const fromLooperPulse = isLooperKind(sourceKind) && isLooperPulseOutput(conn.sourceOutput);
      if (
        !isCvInlet(material, conn.targetInput) &&
        !(fromAnalysis && isNoteInlet(conn.targetInput)) &&
        !(fromLooperPulse && isNoteInlet(conn.targetInput))
      ) {
        continue;
      }
      if (this.lives.get(conn.target)?.audioParams?.[conn.targetInput]) continue;
      const descriptor = material.params[conn.targetInput];
      if (!descriptor) continue;
      let value: number;
      if (fromAnalysis) {
        const view = analysisBus.get(conn.source);
        const held = this.analysisJacks.get(conn.source)?.held;
        value = analysisOutletValue(view, conn.sourceOutput, held);
        if (conn.sourceOutput === 'cv') {
          value = mapModulatorToParam(descriptor, value, 'bipolar');
        } else if (isAnalysisAbsoluteOutput(conn.sourceOutput)) {
          if (value < descriptor.min) value = descriptor.min;
          if (value > descriptor.max) value = descriptor.max;
        }
      } else if (fromLooperPulse) {
        const activity = jackFromOutputs(this.tapFrames.get(conn.source)?.outputs, conn.sourceOutput);
        const pulse = activity.peak > 0.5 ? 1 : 0;
        value = isNoteInlet(conn.targetInput) ? pulse : mapModulatorToParam(descriptor, pulse, 'unipolar');
      } else if (isTransportKind(sourceKind) && isTransportAbsoluteOutput(conn.sourceOutput)) {
        const ctx = this.scene?.audioContext as AudioContext | undefined;
        value = transportFieldValue(
          conn.sourceOutput,
          resolvedTransport(editor.transport),
          this.playing ? (ctx ? this.currentBeats(ctx) : 0) : 0,
          this.playing,
        );
        if (value < descriptor.min) value = descriptor.min;
        if (value > descriptor.max) value = descriptor.max;
      } else {
        const activity = jackFromOutputs(this.tapFrames.get(conn.source)?.outputs, conn.sourceOutput);
        const sourceMaterial = editor.materials.get(conn.source);
        const polarity =
          sourceMaterial?.cvPolarity ??
          (isKeyboardKind(sourceKind) && conn.sourceOutput !== 'cv' ? 'unipolar' : 'bipolar');
        const sample =
          polarity === 'unipolar' ? Math.max(0, activity.mean, activity.peak) : activity.mean;
        value = mapModulatorToParam(descriptor, sample, polarity);
      }
      // A parameter message crosses to the audio thread, and an analyser
      // reading real audio never returns the same number twice, so an
      // unguarded cable posts one message per frame per cable forever. A
      // move too small to hear is not worth a message.
      const key = `${conn.target}:${conn.targetInput}`;
      const previous = this.lastCv.get(key);
      const span = Math.abs(descriptor.max - descriptor.min) || 1;
      if (previous !== undefined && Math.abs(value - previous) < span * CV_SEND_EPSILON) continue;
      this.lastCv.set(key, value);
      try {
        material.setParam(conn.targetInput, value);
        this.setParam(conn.target, conn.targetInput, value);
      } catch {
        /* out of range after taper */
      }
    }
  }

  private stopVoices(): void {
    this.stopMeterLoop();
    this.clearPlayTimers();
    this.teardownClipSources();
    this.lastCv.clear();
    this.timelinePlaying = false;
    if (this.meterSink) {
      try {
        this.meterSink.disconnect();
      } catch {
        /* already gone */
      }
      this.meterSink = null;
    }
    if (this.scene) {
      try {
        resetTimelineScene(this.scene);
      } catch {
        try {
          this.scene.transport.stop();
        } catch {
          /* never started */
        }
        this.scene.disposeLiveVoices();
      }
    }
    for (const off of this.analysisUnsubs) off();
    this.analysisUnsubs = [];
    for (const live of this.lives.values()) {
      live.pool?.allNotesOff();
      for (const handle of live.handles) disposeVoiceHandle(handle);
      try {
        live.mix.disconnect();
      } catch {
        /* already gone */
      }
      if (live.input && live.input !== live.mix) {
        try {
          live.input.disconnect();
        } catch {
          /* already gone */
        }
      }
      live.dispose?.();
    }
    this.lives.clear();
    for (const bank of this.jacks.values()) {
      for (const node of Object.values(bank)) {
        try {
          node.stop();
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
    }
    this.jacks.clear();
    for (const bank of this.midiInJacks.values()) {
      for (const node of Object.values(bank)) {
        try {
          node.stop();
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
    }
    this.midiInJacks.clear();
    this.teardownMidiIo();
    for (const bank of this.transportJacks.values()) {
      stopTransportScalars(bank);
    }
    this.transportJacks.clear();
    for (const bank of this.analysisJacks.values()) {
      stopAnalysisScalars(bank);
    }
    this.analysisJacks.clear();
    for (const bank of this.looperJacks.values()) {
      stopLooperScalars(bank);
    }
    this.looperJacks.clear();
    this.lastAnchor = null;
    this.knownGraphIds.clear();
    this.teardownLines();
    this.clearTaps();
  }

  private armSources(): void {
    const editor = this.editor;
    if (!editor) return;
    const keyed = new Set([...keyedTargets(editor), ...midiInNoteTargets(editor)]);
    for (const [id, live] of this.lives) {
      const material = editor.materials.get(id);
      if (!material || keyed.has(id)) continue;
      if (material.audioInputs.length === 0 && !controlInputs(material).includes('note')) {
        const handle = live.handles[0];
        handle?.noteOn({ ...material.snapshotParams(), note: 69, velocity: 0.85 });
      }
    }
  }

  private startTransport(editor: PatchEditor, ctx: AudioContext): void {
    editor.syncTransportFromGraph();
    const resolved = resolvedTransport(editor.transport);
    const startSec = Math.max(0, resolved.startSec ?? 0);
    const anchor: TransportAnchor = {
      atTime: ctx.currentTime,
      beats: startSec * (resolved.bpm / 60),
      bpm: resolved.bpm,
      playing: true,
      beatsPerBar: resolved.beatsPerBar,
      beatUnit: resolved.beatUnit,
    };
    this.lastAnchor = anchor;
    this.writeTransportJacks(ctx);
    for (const live of this.lives.values()) {
      for (const handle of live.handles) {
        handle.setHostBpm(resolved.bpm);
        handle.setTransport(anchor);
      }
    }
  }

  private publishTransportAnchor(): void {
    const editor = this.editor;
    const ctx = this.scene?.audioContext as AudioContext | undefined;
    if (!editor || !ctx) {
      this.writeTransportJacks(ctx);
      return;
    }
    editor.syncTransportFromGraph();
    const resolved = resolvedTransport(editor.transport);
    if (this.scene) {
      this.scene.transport.bpm = resolved.bpm;
      this.scene.transport.beatsPerBar = resolved.beatsPerBar;
      this.scene.transport.beatUnit = resolved.beatUnit;
      this.scene.publishTransport();
    }
    if (!this.playing) {
      this.writeTransportJacks(ctx);
      return;
    }
    const beats = this.currentBeats(ctx);
    const anchor: TransportAnchor = {
      atTime: ctx.currentTime,
      beats,
      bpm: resolved.bpm,
      playing: true,
      beatsPerBar: resolved.beatsPerBar,
      beatUnit: resolved.beatUnit,
    };
    this.lastAnchor = anchor;
    this.writeTransportJacks(ctx);
    for (const live of this.lives.values()) {
      for (const handle of live.handles) {
        handle.setHostBpm(resolved.bpm);
        handle.setTransport(anchor);
      }
    }
  }

  private currentBeats(ctx: AudioContext): number {
    const anchor = this.lastAnchor;
    if (!anchor || !anchor.playing) return 0;
    return anchor.beats + Math.max(0, ctx.currentTime - anchor.atTime) * (anchor.bpm / 60);
  }

  private writeAnalysisJacks(ctx?: AudioContext): void {
    const audio = ctx ?? (this.scene?.audioContext as AudioContext | undefined);
    if (!audio) return;
    const now = audio.currentTime;
    for (const [id, bank] of this.analysisJacks) {
      writeAnalysisScalars(bank, analysisBus.get(id), now);
    }
  }

  private writeTransportJacks(ctx?: AudioContext): void {
    const audio = ctx ?? (this.scene?.audioContext as AudioContext | undefined);
    if (!audio) return;
    const resolved = resolvedTransport(this.editor?.transport);
    const beats = this.playing ? this.currentBeats(audio) : 0;
    const bars = beats / barBeats(resolved.beatsPerBar, resolved.beatUnit);
    const now = audio.currentTime;
    for (const bank of this.transportJacks.values()) {
      writeTransportScalars(bank, {
        bpm: resolved.bpm,
        beats,
        bars,
        playing: this.playing ? 1 : 0,
        beatsPerBar: resolved.beatsPerBar,
        beatUnit: resolved.beatUnit,
      }, now);
    }
  }

  private createSampleLive(ctx: AudioContext, material: AudioMaterial): LiveNode {
    const mix = ctx.createGain();
    const gain = material.getParam('gain');
    mix.gain.value = Number.isFinite(gain) ? gain : 0.85;
    return { mix, handles: [], pool: null, kernelPoly: false };
  }

  /**
   * Pad audio on the node's mix, the same native path Sample Player uses.
   *
   * The live drum worklet still runs so the cables meter a hit. It does not
   * carry the kit: sixteen WAV tables in processorOptions is how the voice
   * arrives silent on both desktop and iOS. This one-shot is what you hear.
   */
  private triggerDrumNative(live: LiveNode, material: AudioMaterial, note: number, velocity: number): boolean {
    const pad = padIndexFromNote(note);
    if (pad === null) return false;
    const asset = drumPadAsset(material, pad);
    if (!asset || asset.samples.length < 2) return false;
    const ctx = live.mix.context as AudioContext;
    const prepared = prepareClipBuffer(ctx, asset);
    const src = ctx.createBufferSource();
    src.buffer = prepared.buffer;
    const pitch = drumNumber(material, padParamName('pitch', pad), 0);
    src.playbackRate.value = prepared.rateScale * Math.pow(2, pitch / 12);
    const startFrac = drumNumber(material, padParamName('sampleStart', pad), 0);
    const offset = Math.min(Math.max(startFrac, 0), 1) * prepared.buffer.duration;
    const startAt = offset >= prepared.buffer.duration ? 0 : offset;
    const padGain = ctx.createGain();
    const vol = drumNumber(material, padParamName('vol', pad), 1);
    const master = drumNumber(material, 'masterVol', 1);
    padGain.gain.value = vol * midiVelocity(velocity) * master;
    const pan = drumNumber(material, padParamName('pan', pad), 0);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.min(1, Math.max(-1, pan));
    src.connect(padGain);
    padGain.connect(panner);
    panner.connect(live.mix);
    src.onended = () => {
      try {
        src.disconnect();
        padGain.disconnect();
        panner.disconnect();
      } catch {
        /* already gone */
      }
    };
    src.start(ctx.currentTime, startAt);
    this.clipSources.push(src);
    return true;
  }

  private createMixerLive(native: { input: AudioNode; mix: GainNode; setParam: (name: string, value: number) => void }): LiveNode {
    return {
      mix: native.mix,
      input: native.input,
      handles: [],
      pool: null,
      kernelPoly: false,
      nativeSetParam: native.setParam,
    };
  }

  private armSampleClips(editor: PatchEditor, ctx: AudioContext): void {
    const startSec = Math.max(0, editor.transport?.startSec ?? 0);
    for (const [id, live] of this.lives) {
      if ((editor.kinds.get(id) ?? '') !== 'sampleplayer') continue;
      const material = editor.materials.get(id);
      const sample = material ? sampleAsset(material) : undefined;
      if (!material || !sample || sample.samples.length < 2) continue;
      const clipOffset = Number(editor.nodeData(id)?.clipOffsetSec);
      const clipDur = Number(editor.nodeData(id)?.clipDurationSec);
      const delay = Math.max(0, (Number.isFinite(clipOffset) ? clipOffset : 0) - startSec);
      const prepared = prepareClipBuffer(ctx, sample);
      const src = ctx.createBufferSource();
      src.buffer = prepared.buffer;
      const rate = material.getParam('rate');
      const pitch = material.getParam('pitch');
      const rateMul = (Number.isFinite(rate) ? rate : 1) * Math.pow(2, (Number.isFinite(pitch) ? pitch : 0) / 12);
      const userRate = Math.min(4, Math.max(0.25, rateMul));
      src.playbackRate.value = userRate * prepared.rateScale;
      src.loop = material.getParam('loop') > 0.5;
      const startFrac = material.getParam('start');
      const offset =
        Math.min(Math.max(Number.isFinite(startFrac) ? startFrac : 0, 0), 1) * prepared.buffer.duration;
      src.connect(live.input ?? live.mix);
      const when = ctx.currentTime + delay;
      if (Number.isFinite(clipDur) && clipDur > 0) {
        src.start(when, offset, clipDur * userRate * prepared.rateScale);
      } else {
        src.start(when, offset);
      }
      this.clipSources.push(src);
    }
  }

  private armMidiClips(editor: PatchEditor, ctx: AudioContext, onlyKind?: string): void {
    const bpm = editor.transport?.bpm && editor.transport.bpm > 0 ? editor.transport.bpm : 120;
    const startSec = Math.max(0, editor.transport?.startSec ?? 0);
    const now = ctx.currentTime;
    for (const node of editor.editor.getNodes()) {
      if (!isMidiClipKind(editor.kinds.get(node.id) ?? '')) continue;
      const destId = midiClipTarget(editor, node.id);
      const live = destId ? this.lives.get(destId) : undefined;
      if (!live) continue;
      if (onlyKind && (editor.kinds.get(destId) ?? '') !== onlyKind) continue;
      const placed = placeMidiClip(editor.nodeData(node.id));
      for (const note of placed.notes) {
        const onSec = placed.offsetSec + Math.max(0, note.startBeat) * (60 / bpm);
        const durSec = Math.max(0.02, note.durationBeats * (60 / bpm));
        const when = now + (onSec - startSec);
        const off = when + durSec;
        if (off < now - 0.05) continue;
        this.fireMidi(live, editor.materials.get(destId!) ?? null, note.pitch, note.velocity, Math.max(when, now), off);
      }
    }
  }

  private fireMidi(
    live: LiveNode,
    material: AudioMaterial | null,
    pitch: number,
    velocity: number,
    when: number,
    off: number,
  ): void {
    const handle = live.handles[0];
    const playNote = material?.kind === 'drum' ? drumLiveNote(pitch) : pitch;
    if (material?.kind === 'drum') {
      const onMs = Math.max(0, (when - (live.mix.context.currentTime ?? when)) * 1000);
      this.playTimers.push(
        window.setTimeout(() => {
          this.triggerDrumNative(live, material, pitch, velocity);
          if (handle) handle.noteOn({ ...material.snapshotParams(), note: playNote, velocity });
        }, onMs),
      );
      return;
    }
    if (live.kernelPoly && handle) {
      handle.midiNoteOn(playNote, velocity, when);
      handle.midiNoteOff(playNote, off);
      return;
    }
    const onMs = Math.max(0, (when - (handle?.node.context.currentTime ?? when)) * 1000);
    const offMs = Math.max(0, (off - (handle?.node.context.currentTime ?? off)) * 1000);
    this.playTimers.push(
      window.setTimeout(() => {
        if (live.pool) live.pool.noteOn(playNote, { velocity });
        else if (handle && material) handle.noteOn({ ...material.snapshotParams(), note: playNote, velocity });
      }, onMs),
    );
    this.playTimers.push(
      window.setTimeout(() => {
        if (live.pool) live.pool.noteOff(pitch);
        else handle?.noteOff();
      }, offMs),
    );
  }

  private teardownClipSources(): void {
    for (const src of this.clipSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.clipSources = [];
  }

  private clearPlayTimers(): void {
    for (const id of this.playTimers) window.clearTimeout(id);
    this.playTimers = [];
  }

  private async createLive(
    ctx: AudioContext,
    renderer: WebAudioRenderer,
    material: AudioMaterial,
    nodeId: string,
  ): Promise<LiveNode> {
    const kernelPoly = material.kind === 'synth' || material.kind === 'grain';
    const count = kernelPoly ? 1 : Math.min(TESTER_VOICE_CAP, Math.max(1, material.polyphony));
    const handles: VoiceHandle[] = [];
    if (material.kind === 'drum') ensureDrumPadBoxes(material);
    for (let i = 0; i < count; i += 1) {
      // The authored drum graph is the 026S chain. Sixteen of those on every
      // sample does not finish a worklet block in time, so the outlet stays
      // silent. The live graph is the same pads and boxes without that chain.
      const graph = material.kind === 'drum' ? liveDrumGraph(material) : material.graph;
      const handle = await renderer.createVoice(graph);
      for (const [name, value] of Object.entries(material.snapshotParams())) {
        try {
          handle.setParam(name, value);
        } catch {
          /* voice may not expose every declared param */
        }
      }
      handles.push(handle);
    }
    const plugin = audioMaterialRegistry.forMaterial(material);
    if (plugin?.bindLiveVoice) {
      try {
        const wasm = await patcherKernelBinaries();
        for (const handle of handles) {
          await plugin.bindLiveVoice(handle, material, wasm);
        }
      } catch (err) {
        console.warn(`[crate-patcher] kernel bind failed for ${nodeId} (${material.kind})`, err);
      }
    }
    if (isAnalysisKind(material.kind)) {
      const rate = ctx.sampleRate;
      for (const handle of handles) {
        handle.setAnalysisInterval(20);
        this.analysisUnsubs.push(
          handle.onAnalysis((frame) => {
            const view = deriveAnalysis(frame, rate);
            analysisBus.set(nodeId, view);
            const bank = this.analysisJacks.get(nodeId);
            const ctx = this.scene?.audioContext as AudioContext | undefined;
            if (bank && ctx) writeAnalysisScalars(bank, view, ctx.currentTime);
          }),
        );
      }
    }
    if (isLooperKind(material.kind)) {
      const blockHz = Math.max(1, Math.round(ctx.sampleRate / 128));
      for (const handle of handles) {
        handle.setAnalysisInterval(blockHz);
        this.analysisUnsubs.push(
          handle.onAnalysis((frame) => {
            const bank = this.looperJacks.get(nodeId);
            const audio = this.scene?.audioContext as AudioContext | undefined;
            if (!bank || !audio) return;
            writeLooperPulses(
              bank,
              frame.meters[LOOPER_START_TAP]?.peak ?? 0,
              frame.meters[LOOPER_END_TAP]?.peak ?? 0,
              audio.currentTime,
              audio.sampleRate,
            );
            if ((frame.meters[LOOPER_START_TAP]?.peak ?? 0) > 0.5) this.midiPulseLatch.add(`${nodeId}:start`);
            if ((frame.meters[LOOPER_END_TAP]?.peak ?? 0) > 0.5) this.midiPulseLatch.add(`${nodeId}:end`);
          }),
        );
      }
    }
    const mix = ctx.createGain();
    mix.gain.value = 1;
    const backends: VoiceBackend[] = handles.map((handle) => ({
      noteOn: (params) => handle.noteOn(params),
      noteOff: () => handle.noteOff(),
      setParam: (name, value) => handle.setParam(name, value),
    }));
    const pool = !kernelPoly && count > 1 ? new VoicePool(material, backends, material.voiceStealing ?? 'oldest') : null;
    return { mix, handles, pool, kernelPoly };
  }

  private publishVoices(): void {
    const editor = this.editor;
    const analog = this.analog;
    if (!editor || !analog) return;
    const id = keyedTargets(editor)[0];
    const material = id ? editor.materials.get(id) : null;
    const live = id ? this.lives.get(id) : null;
    analog.setVoiceView({
      polyphony: material?.polyphony ?? analog.polyphony,
      steal: stealLabel(material?.voiceStealing),
      targetName: material?.name ?? '',
      lamps: live?.pool
        ? live.pool.snapshots().map((slot) => ({ index: slot.index, note: slot.note, held: slot.held }))
        : undefined,
    });
  }

  private clearTaps(): void {
    for (const tap of this.taps.values()) {
      try {
        tap.node.disconnect(tap.analyser);
      } catch {
        /* already gone */
      }
    }
    this.taps.clear();
  }
}

export function applyParam(material: AudioMaterial, name: string, value: number): void {
  material.setParam(name, value);
}

function isKeyboardOut(name: string): name is KeyboardOutput {
  return (KEYBOARD_OUTPUTS as readonly string[]).includes(name);
}

function midiClipTarget(editor: PatchEditor, clipId: string): string | null {
  for (const conn of editor.editor.getConnections()) {
    if (conn.source !== clipId) continue;
    const material = editor.materials.get(conn.target);
    if (!material) continue;
    if (isNoteInlet(conn.targetInput)) return conn.target;
  }
  return null;
}

function keyedTargets(editor: PatchEditor): string[] {
  const ids = new Set<string>();
  for (const conn of editor.editor.getConnections()) {
    if (!isKeyboardKind(editor.kinds.get(conn.source) ?? '')) continue;
    const material = editor.materials.get(conn.target);
    if (!material) continue;
    if (isNoteInlet(conn.targetInput)) ids.add(conn.target);
  }
  return [...ids];
}

function midiInNoteTargets(editor: PatchEditor, sourceId?: string): string[] {
  const ids = new Set<string>();
  for (const conn of editor.editor.getConnections()) {
    if (sourceId && conn.source !== sourceId) continue;
    if (!isMidiInKind(editor.kinds.get(conn.source) ?? '')) continue;
    const material = editor.materials.get(conn.target);
    if (!material) continue;
    if (isNoteInlet(conn.targetInput)) ids.add(conn.target);
  }
  return [...ids];
}

function analogFromMidi(
  type: 'press' | 'release',
  note: number,
  velocity: number,
  snap: MidiInputSnapshot,
): AnalogEvent {
  return {
    type,
    note,
    velocity,
    snapshot: {
      note: snap.note,
      velocity: snap.velocity,
      gate: snap.gate,
      cv: snap.cv,
      held: snap.held,
      polyphony: 1,
      steal: 'oldest',
      targetName: '',
      lamps: [],
    },
  };
}

function createMidiInJacks(ctx: AudioContext): MidiInJacks {
  const cv = ctx.createConstantSource();
  const gate = ctx.createConstantSource();
  const trig = ctx.createConstantSource();
  const velocity = ctx.createConstantSource();
  const note = ctx.createConstantSource();
  const cc = ctx.createConstantSource();
  cv.offset.value = 0;
  gate.offset.value = 0;
  trig.offset.value = 0;
  velocity.offset.value = 0;
  note.offset.value = 60;
  cc.offset.value = 0;
  cv.start();
  gate.start();
  trig.start();
  velocity.start();
  note.start();
  cc.start();
  return { cv, gate, trig, velocity, note, cc };
}

function writeMidiInJacks(
  bank: MidiInJacks,
  snapshot: MidiInputSnapshot | undefined,
  now: number,
  pulse: boolean,
): void {
  // The levels come from crate (`midi/midiHostIo.ts`) so this file is only the
  // Web Audio half. `trig` is not among them: it is an edge the host schedules.
  const levels = midiInOutlets(snapshot);
  bank.cv.offset.setValueAtTime(levels.cv, now);
  bank.gate.offset.setValueAtTime(levels.gate, now);
  bank.velocity.offset.setValueAtTime(levels.velocity, now);
  bank.note.offset.setValueAtTime(levels.note, now);
  bank.cc.offset.setValueAtTime(levels.cc, now);
  if (pulse) {
    bank.trig.offset.cancelScheduledValues(now);
    bank.trig.offset.setValueAtTime(1, now);
    bank.trig.offset.setValueAtTime(0, now + MIDI_TRIG_SECONDS);
  } else if (levels.gate < 0.5) {
    bank.trig.offset.setValueAtTime(0, now);
  }
}

function drumNumber(material: AudioMaterial, name: string, fallback: number): number {
  try {
    const value = material.getParam(name);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function driveLive(live: LiveNode, material: AudioMaterial, event: AnalogEvent): void {
  const note = material.kind === 'drum' ? drumLiveNote(event.note) : event.note;
  const { velocity, snapshot } = event;
  const handle = live.handles[0];
  if (live.kernelPoly && handle) {
    if (event.type === 'press') handle.midiNoteOn(note, velocity);
    else handle.midiNoteOff(note);
    return;
  }
  if (live.pool) {
    if (event.type === 'press') live.pool.noteOn(note, { velocity });
    else live.pool.noteOff(note);
    return;
  }
  if (!handle) return;
  if (event.type === 'press') {
    handle.noteOn({ ...material.snapshotParams(), note, velocity });
    return;
  }
  if (snapshot.gate < 0.5) {
    handle.noteOff();
    return;
  }
  handle.noteOn({ ...material.snapshotParams(), note: snapshot.note, velocity: snapshot.velocity });
}

function createJacks(ctx: AudioContext): KeyboardJacks {
  const cv = ctx.createConstantSource();
  const gate = ctx.createConstantSource();
  const trig = ctx.createConstantSource();
  const velocity = ctx.createConstantSource();
  cv.offset.value = 0;
  gate.offset.value = 0;
  trig.offset.value = 0;
  velocity.offset.value = 0;
  cv.start();
  gate.start();
  trig.start();
  velocity.start();
  return { cv, gate, trig, velocity };
}

function writeJacks(bank: KeyboardJacks, snapshot: AnalogSnapshot | undefined, now: number, pulse: boolean): void {
  const gate = snapshot?.gate ?? 0;
  bank.cv.offset.setValueAtTime(snapshot?.cv ?? 0, now);
  bank.gate.offset.setValueAtTime(gate, now);
  bank.velocity.offset.setValueAtTime(snapshot?.velocity ?? 0, now);
  if (pulse) {
    bank.trig.offset.cancelScheduledValues(now);
    bank.trig.offset.setValueAtTime(1, now);
    bank.trig.offset.setValueAtTime(0, now + TRIG_SECONDS);
  } else if (gate < 0.5) {
    bank.trig.offset.setValueAtTime(0, now);
  }
}

function createTransportJacks(ctx: AudioContext, pulse: AudioNode): TransportJacks {
  const bpm = ctx.createConstantSource();
  const beats = ctx.createConstantSource();
  const bars = ctx.createConstantSource();
  const playing = ctx.createConstantSource();
  const beatsPerBar = ctx.createConstantSource();
  const beatUnit = ctx.createConstantSource();
  bpm.offset.value = 120;
  beats.offset.value = 0;
  bars.offset.value = 0;
  playing.offset.value = 0;
  beatsPerBar.offset.value = 4;
  beatUnit.offset.value = 4;
  bpm.start();
  beats.start();
  bars.start();
  playing.start();
  beatsPerBar.start();
  beatUnit.start();
  return { bpm, beats, bars, playing, beatsPerBar, beatUnit, pulse };
}

function transportJackNode(bank: TransportJacks, output: string): AudioNode {
  if (output === 'pulse' || output === 'cv' || output === 'audio') return bank.pulse;
  if (output in bank) return bank[output as TransportOutput];
  return bank.pulse;
}

function writeTransportScalars(
  bank: TransportJacks,
  values: {
    bpm: number;
    beats: number;
    bars: number;
    playing: number;
    beatsPerBar: number;
    beatUnit: number;
  },
  now: number,
): void {
  bank.bpm.offset.setValueAtTime(values.bpm, now);
  bank.beats.offset.setValueAtTime(values.beats, now);
  bank.bars.offset.setValueAtTime(values.bars, now);
  bank.playing.offset.setValueAtTime(values.playing, now);
  bank.beatsPerBar.offset.setValueAtTime(values.beatsPerBar, now);
  bank.beatUnit.offset.setValueAtTime(values.beatUnit, now);
}

function createAnalysisJacks(ctx: AudioContext, kind: string, audio: AudioNode): AnalysisJacks {
  const scalars = new Map<string, ConstantSourceNode>();
  for (const name of analysisOutputs(kind)) {
    if (name === 'audio') continue;
    const node = ctx.createConstantSource();
    node.offset.value = 0;
    node.start();
    scalars.set(name, node);
  }
  return { audio, scalars, held: { note: 0, hz: 0, cents: 0 } };
}

function analysisJackNode(bank: AnalysisJacks, output: string): AudioNode {
  return bank.scalars.get(output) ?? bank.audio;
}

function createLooperJacks(ctx: AudioContext, audio: AudioNode): LooperJacks {
  const start = ctx.createConstantSource();
  start.offset.value = 0;
  start.start();
  const end = ctx.createConstantSource();
  end.offset.value = 0;
  end.start();
  return { audio, start, end };
}

function looperJackNode(bank: LooperJacks, output: string): AudioNode {
  if (output === 'start') return bank.start;
  if (output === 'end') return bank.end;
  return bank.audio;
}

function writeLooperPulses(
  bank: LooperJacks,
  startPeak: number,
  endPeak: number,
  now: number,
  sampleRate: number,
): void {
  const width = 1 / Math.max(sampleRate, 1);
  if (startPeak > 0.5) {
    bank.start.offset.setValueAtTime(1, now);
    bank.start.offset.setValueAtTime(0, now + width);
  } else {
    bank.start.offset.setValueAtTime(0, now);
  }
  if (endPeak > 0.5) {
    bank.end.offset.setValueAtTime(1, now);
    bank.end.offset.setValueAtTime(0, now + width);
  } else {
    bank.end.offset.setValueAtTime(0, now);
  }
}

function disconnectLooperScalars(bank: LooperJacks): void {
  for (const node of [bank.start, bank.end]) {
    try {
      node.disconnect();
    } catch {
      /* already gone */
    }
  }
}

function stopLooperScalars(bank: LooperJacks): void {
  for (const node of [bank.start, bank.end]) {
    try {
      node.stop();
      node.disconnect();
    } catch {
      /* already gone */
    }
  }
}

function writeAnalysisScalars(bank: AnalysisJacks, view: ReturnType<typeof analysisBus.get>, now: number): void {
  if (view && view.hz > 0 && Number.isFinite(view.midi)) {
    bank.held.note = view.midi;
    bank.held.hz = view.hz;
    bank.held.cents = Number.isFinite(view.cents) ? view.cents : 0;
  }
  for (const [name, node] of bank.scalars) {
    node.offset.setValueAtTime(analysisOutletValue(view, name, bank.held), now);
  }
}

function disconnectAnalysisScalars(bank: AnalysisJacks): void {
  for (const node of bank.scalars.values()) {
    try {
      node.disconnect();
    } catch {
      /* already gone */
    }
  }
}

function stopAnalysisScalars(bank: AnalysisJacks): void {
  for (const node of bank.scalars.values()) {
    try {
      node.stop();
      node.disconnect();
    } catch {
      /* already gone */
    }
  }
}

function disconnectTransportScalars(bank: TransportJacks): void {
  for (const name of ['bpm', 'beats', 'bars', 'playing', 'beatsPerBar', 'beatUnit'] as const) {
    try {
      bank[name].disconnect();
    } catch {
      /* already gone */
    }
  }
}

function stopTransportScalars(bank: TransportJacks): void {
  for (const name of ['bpm', 'beats', 'bars', 'playing', 'beatsPerBar', 'beatUnit'] as const) {
    try {
      bank[name].stop();
      bank[name].disconnect();
    } catch {
      /* already gone */
    }
  }
}

function transportFieldValue(
  field: string,
  transport: { bpm: number; beatsPerBar: number; beatUnit: number },
  beats: number,
  playing: boolean,
): number {
  switch (field) {
    case 'bpm':
      return transport.bpm;
    case 'beats':
      return beats;
    case 'bars':
      return beats / barBeats(transport.beatsPerBar, transport.beatUnit);
    case 'playing':
      return playing ? 1 : 0;
    case 'beatsPerBar':
      return transport.beatsPerBar;
    case 'beatUnit':
      return transport.beatUnit;
    default:
      return 0;
  }
}

function makeTap(ctx: AudioContext, node: AudioNode, sink?: AudioNode | null, fftSize = 256): Tap {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  node.connect(analyser);
  if (sink) analyser.connect(sink);
  return {
    node,
    analyser,
    buffer: new Float32Array(analyser.fftSize),
    wave: new Float32Array(32),
    heldPeak: 0,
    lastMs: 0,
  };
}

export type { JackActivity };
