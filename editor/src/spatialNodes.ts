/**
 * Live implementations for the two spatial node kinds, plus the rules the
 * editor needs to keep B-format cables away from ordinary audio ones.
 *
 * Follows the `nativeMixer.ts` pattern: the Material carries the params and
 * the serialization, and the sound is made by something the ASL interpreter
 * has no way to express. Here that is an `AudioWorkletNode` with four output
 * channels for the source, and a graph of gains and panners for the master.
 *
 * ## The part that is not like `nativeMixer`
 *
 * These expose `audioParams`. A `GainNode` fader is written by message from
 * the meter loop, which is fine for a fader. Position is not fine that way:
 * `applyCv` samples an analyser at roughly 20 Hz, and an LFO on an axis
 * through that path is an audible staircase rather than a sweep.
 *
 * So `audio.ts` connects a CV cable straight to the `AudioParam` when the
 * target has one, and skips it in `applyCv`. The signal then adds to the
 * param's own value the way a modular patch does: an LFO at amount 1 into `x`
 * swings the source a metre either side of wherever the inspector left it.
 */
import { SpatialBus, SPATIAL_DECODE_MODES, FOA_ENCODER_PROCESSOR, type Material } from '../../src/index';

export interface SpatialLive {
  input: AudioNode;
  mix: GainNode;
  setParam: (name: string, value: number) => void;
  /** Params a cable may drive at audio rate, keyed by inlet name. */
  audioParams: Record<string, AudioParam>;
  dispose?: () => void;
}

/**
 * Ports that carry B-format rather than audio, keyed by node kind.
 *
 * Keyed by kind and port name rather than by a naming convention, because the
 * port names come from the Material's graph (`input`, `audio`) and renaming
 * them would make these two nodes serialize unlike every other node in a
 * patch for no gain.
 */
const BFORMAT_PORTS: Record<string, { inputs: readonly string[]; outputs: readonly string[] }> = {
  spatialsource: { inputs: [], outputs: ['audio'] },
  spatialmaster: { inputs: ['input'], outputs: [] },
};

/** True when this port carries four channels of ambisonics. */
export function isBformatPort(kind: string, side: 'input' | 'output', name: string): boolean {
  const ports = BFORMAT_PORTS[kind];
  if (!ports) return false;
  return (side === 'input' ? ports.inputs : ports.outputs).includes(name);
}

export function isSpatialSourceKind(kind: string): boolean {
  return kind === 'spatialsource';
}

export function isSpatialMasterKind(kind: string): boolean {
  return kind === 'spatialmaster';
}

export function isSpatialKind(kind: string): boolean {
  return isSpatialSourceKind(kind) || isSpatialMasterKind(kind);
}

/**
 * A source: mono in, four channels of direction out.
 *
 * The trailing `GainNode` is not decoration. `LiveNode.mix` is the editor's
 * one handle on a node's output, and it is typed as a `GainNode` because
 * everything else in the graph ends in one. Setting its channel count
 * explicitly is also what stops the platform from helpfully folding four
 * channels down to two on the way to the master.
 */
export function createSpatialSource(ctx: AudioContext, material: Material | undefined): SpatialLive {
  const node = new AudioWorkletNode(ctx, FOA_ENCODER_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [4],
  });

  const mix = ctx.createGain();
  mix.gain.value = 1;
  mix.channelCount = 4;
  mix.channelCountMode = 'explicit';
  mix.channelInterpretation = 'discrete';
  node.connect(mix);

  const get = (name: string): AudioParam | undefined => node.parameters.get(name) ?? undefined;
  const set = (name: string, value: number): void => {
    const param = get(name);
    if (param && Number.isFinite(value)) param.value = value;
  };

  for (const name of ['x', 'y', 'z', 'gain', 'global', 'distanceModel']) {
    const value = material?.getParam(name);
    if (typeof value === 'number') set(name, value);
  }

  const audioParams: Record<string, AudioParam> = {};
  for (const name of ['x', 'y', 'z', 'gain']) {
    const param = get(name);
    if (param) audioParams[name] = param;
  }

  return { input: node, mix, setParam: set, audioParams };
}

/**
 * The master: B-format in, stereo out.
 *
 * `decode` is an enum index on the Material and a string on the bus, so the
 * mapping goes through `SPATIAL_DECODE_MODES`, which is declared next to the
 * enum it mirrors rather than inline here.
 */
export function createSpatialMaster(ctx: AudioContext, material: Material | undefined): SpatialLive {
  const decodeIndex = Math.round(material?.getParam('decode') ?? 0);
  const bus = new SpatialBus(ctx, {
    decode: SPATIAL_DECODE_MODES[decodeIndex] ?? 'binaural',
  });
  bus.setYawPitch(material?.getParam('yaw') ?? 0, material?.getParam('pitch') ?? 0);

  const level = ctx.createGain();
  level.gain.value = material?.getParam('level') ?? 1;
  bus.output.connect(level);

  let yaw = material?.getParam('yaw') ?? 0;
  let pitch = material?.getParam('pitch') ?? 0;

  const setParam = (name: string, value: number): void => {
    if (!Number.isFinite(value)) return;
    if (name === 'yaw') {
      yaw = value;
      bus.setYawPitch(yaw, pitch);
    } else if (name === 'pitch') {
      pitch = value;
      bus.setYawPitch(yaw, pitch);
    } else if (name === 'level') {
      level.gain.value = value;
    } else if (name === 'decode') {
      const mode = SPATIAL_DECODE_MODES[Math.round(value)];
      if (mode) bus.setDecode(mode);
    }
  };

  return {
    input: bus.input,
    mix: level,
    setParam,
    // `level` is the only one that is a real AudioParam. Yaw and pitch go
    // through `sin`/`cos` to reach the rotation coefficients, so a cable into
    // them stays on the control-rate path, which is what head rotation wants
    // anyway.
    audioParams: { level: level.gain },
    dispose: () => bus.dispose(),
  };
}
