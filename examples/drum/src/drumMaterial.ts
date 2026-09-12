import {
  AudioMaterial,
  compare,
  env,
  logic,
  mix,
  samplePlay,
  select,
  uniform,
  type AudioMaterialGraphContext,
  type ASLGraphDescriptor,
  type ASLValue,
  type SampleBox,
} from './crate';
import { NUM_PADS, PAD_BASE_NOTE, drumAutomatable, drumParams, padParamName } from './drumParams';
import { attachPadBoxes, createPadBoxes, drumPadBoxes } from './drumPads';
import {
  bitCrusher026S,
  bitTrim,
  cascadeLowpass3,
  padLowpass,
  panned,
} from './drumDsp';
import { DEFAULT_IR_CUTOFF, DEFAULT_IR_RESONANCE, IR_FFT_GAIN } from './drumConstants';

export interface DrumMaterialOptions {
  /**
   * The rate the character chain is built for.
   *
   * The AU takes it in `initialize(sampleRate, maxFrames)` and so does this,
   * for the same reason: the bit crusher's knob runs from about 1 kHz up to
   * the engine rate, and the unit delay inside the master filter is one
   * sample. An ASL graph has no way to ask what rate it is about to run at,
   * so the rate is a build-time argument here rather than something the
   * graph reads. Wrong by 8% (48k material at 44.1k) moves the crusher's
   * hold rate and the master filter's coefficient by the same 8%.
   */
  sampleRate?: number;
}

/**
 * Long enough that a per-pad latch does not measurably decay over the life of
 * a one-shot. `dahdsr` has no hold-forever stage, and it does not need one:
 * a release this long moves the level by about one part in a million across
 * a whole song.
 */
const LATCH_RELEASE_SECONDS = 1e6;

function padGate(note: ASLValue, gate: ASLValue, pad: number): ASLValue {
  const padNote = PAD_BASE_NOTE + pad;
  const isPad = logic.and(
    compare(note, { threshold: padNote - 0.5, mode: 'gt' }),
    compare(note, { threshold: padNote + 0.5, mode: 'lt' }),
  );
  return gate.mul(isPad);
}

/**
 * A 16-pad sampler as one graph.
 *
 * ## Why it is one voice with sixteen branches
 *
 * The AU is not polyphonic. It has sixteen playheads, one per pad, and a
 * note-on writes the playhead for `note - 36`. Note-offs are ignored because
 * a pad is a one-shot. This graph is the same shape: `polyphony: 1`, and
 * each pad is a branch gated by its own note.
 *
 * That is also the only shape that runs. Sixteen voices each carrying
 * sixteen branches is the same work sixteen times over, because ASL has no
 * way to index a sample bank or a parameter by a value: a pad cannot be
 * *chosen*, only compared against. Sixteen branches always run, including
 * the fifteen that are silent. It is the one place this instrument pays a
 * real price for being a graph rather than a loop, and README.md has the
 * measured number.
 *
 * ## Retriggering
 *
 * `VoicePool` gates off before it gates on when it reuses a slot, so hitting
 * one pad twice does produce two edges. The pad's own gate is the voice gate
 * ANDed with a note match, which means the other fifteen pads see no edge
 * and keep playing: exactly the AU's "note-offs are ignored".
 */
function drumGraph(boxes: SampleBox[], sampleRate: number) {
  return ({ note, velocity, params }: AudioMaterialGraphContext): ASLValue => {
    // The voice gate as a value. ASL has no `gate` node, but an envelope with
    // no times is one: it reads the same `state.gate` and reports 0 or 1.
    const gate = env.dahdsr({ attack: 0, decay: 0, sustain: 1, release: 0 });

    const pads: ASLValue[] = [];
    for (let pad = 0; pad < NUM_PADS; pad++) {
      const padNote = PAD_BASE_NOTE + pad;
      const isPad = logic.and(
        compare(note, { threshold: padNote - 0.5, mode: 'gt' }),
        compare(note, { threshold: padNote + 0.5, mode: 'lt' }),
      );
      const padGate = gate.mul(isPad);
      // Velocity, latched at this pad's own trigger. The AU keeps
      // `padVelocities[i]` from note-on until the pad is hit again; without
      // the latch a hit on any other pad would re-scale this one mid-decay.
      const padVelocity = env
        .dahdsr({ attack: 0, decay: 0, sustain: 1, release: LATCH_RELEASE_SECONDS, gate: padGate })
        .trigger(velocity);

      const p = (bank: Parameters<typeof padParamName>[0]) => params[padParamName(bank, pad)]!;

      const dry = samplePlay({
        rate: 1,
        gate: padGate,
        position: p('sampleStart'),
        pitch: p('pitch'),
        box: boxes[pad],
      });

      const bits = p('bits');
      const crushed = bitCrusher026S(dry, { bits, srate: p('srate'), sampleRate }).mul(bitTrim(bits));
      const wet = padLowpass(crushed, { cutoff: p('cut'), res: p('res') });
      const chain = select(wet, dry, { which: params.masterBypassPadDSP! });

      pads.push(panned(chain.mul(p('vol')).mul(padVelocity), p('pan')));
    }

    const bus = mix(...pads);
    const filtered = cascadeLowpass3(bus, {
      cutoff: params.masterCut!,
      res: params.masterRes!,
      sampleRate,
    });

    // The character IR is a filter.
    //
    // `synthesizeDefaultMasterIR` runs a unit impulse through an 18 dB/oct
    // low-pass at 17 kHz and keeps 1024 samples of it, then convolves with
    // that. Convolving with a filter's impulse response is running the
    // filter, so the wet path is the same cascade again at fixed settings and
    // no convolution is needed. The doubling is not a mistake: vDSP's real
    // FFT round trip leaves the AU's wet path at twice the mathematical
    // convolution, and that gain is shipped.
    //
    // A user-loaded IR is the one stage of this instrument with no ASL
    // expression at all.
    const irMix = params.masterIRMix!;
    const character = cascadeLowpass3(filtered, {
      cutoff: uniform(DEFAULT_IR_CUTOFF),
      res: uniform(DEFAULT_IR_RESONANCE),
      sampleRate,
    }).mul(IR_FFT_GAIN);
    const mixed = filtered.mul(irMix.mul(-1).add(1)).add(character.mul(irMix));

    return mixed.mul(params.masterVol!);
  };
}

export function createDrumMaterial(options: DrumMaterialOptions = {}): AudioMaterial {
  const sampleRate = options.sampleRate ?? 48000;
  const boxes = createPadBoxes();
  const material = new AudioMaterial({
    name: 'Drum',
    kind: 'drum',
    params: drumParams,
    automatable: drumAutomatable,
    polyphony: 1,
    // Pads pan, so the two channels carry different samples and each pad
    // filter needs its own state per side. `panned` reads `audio.lane()`,
    // which would set this on its own; declaring it says so out loud.
    channels: 2,
    graph: drumGraph(boxes, sampleRate),
  });
  attachPadBoxes(material, boxes);
  return material;
}

/**
 * Sample playback, volume, velocity and pan. No crusher, no pad filter, no
 * character stage.
 *
 * The full instrument is sixteen of those stages on every sample, twice for
 * stereo, and that does not finish a worklet block before the next one is
 * due. Play in the editor therefore uses this graph: same pads, same boxes,
 * same note map, cheap enough that a hit actually leaves the outlet.
 */
function drumLiveGraph(boxes: SampleBox[]) {
  return ({ note, velocity, params }: AudioMaterialGraphContext): ASLValue => {
    const gate = env.dahdsr({ attack: 0, decay: 0, sustain: 1, release: 0 });
    const pads = Array.from({ length: NUM_PADS }, (_, pad) => {
      const hit = padGate(note, gate, pad);
      const p = (bank: Parameters<typeof padParamName>[0]) => params[padParamName(bank, pad)]!;
      return samplePlay({
        rate: 1,
        gate: hit,
        position: p('sampleStart'),
        pitch: p('pitch'),
        box: boxes[pad],
      })
        .mul(p('vol'))
        .mul(velocity);
    });
    return mix(...pads).mul(params.masterVol!);
  };
}

/**
 * The graph a live voice should compile, sharing this material's pad boxes.
 *
 * Falls back to the authored graph when boxes were never attached, so a
 * caller that only has the descriptor still has something to compile.
 */
export function liveDrumGraph(material: AudioMaterial): ASLGraphDescriptor {
  const boxes = drumPadBoxes(material);
  if (!boxes) return material.graph;
  return new AudioMaterial({
    name: 'Drum Live',
    kind: 'drum',
    params: drumParams,
    polyphony: 1,
    channels: 1,
    graph: drumLiveGraph(boxes),
  }).graph;
}

export const drumPluginMaterial = createDrumMaterial();
