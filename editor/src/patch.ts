/**
 * A crate.patch: a Material graph plus editor positions.
 * Not a DAW project (those are tracks, clips, and plugin slots).
 */

export const PATCH_KIND = 'crate.patch';
export const PATCH_VERSION = 1;

export interface PatchTransport {
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
  /** Playhead in seconds when Play is pressed. Imported songs seek to the first clip. */
  startSec?: number;
}

export interface PatchMidiNote {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
}

export interface PatchNode {
  id: string;
  kind: string;
  x: number;
  y: number;
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface PatchConnection {
  source: string;
  sourceOutput: string;
  target: string;
  targetInput: string;
}

export interface CratePatch {
  version: number;
  kind: typeof PATCH_KIND;
  nodes: PatchNode[];
  connections: PatchConnection[];
  transport?: PatchTransport;
}

export function emptyPatch(): CratePatch {
  return { version: PATCH_VERSION, kind: PATCH_KIND, nodes: [], connections: [] };
}

/**
 * Default editor graph. Keyboard voice (osc, ADSR into cutoff, LFO into
 * width) through lowpass, delay, and reverb. A Line into Amp feeds Master,
 * tuner, analyzer, and looper in parallel.
 */
export function starterPatch(): CratePatch {
  return {
    version: PATCH_VERSION,
    kind: PATCH_KIND,
    transport: { bpm: 120, beatsPerBar: 4, beatUnit: 4 },
    nodes: [
      { id: 'transport', kind: 'transport', x: 36, y: 36, params: { bpm: 120, beatsPerBar: 4, beatUnit: 4 } },
      { id: 'keys', kind: 'keyboard', x: 36, y: 340, params: {} },
      {
        id: 'osc',
        kind: 'oscillator',
        x: 280,
        y: 36,
        params: { type: 1, width: 0.5, octave: 0, detune: 0, gain: 0.35 },
      },
      {
        id: 'adsr',
        kind: 'adsr',
        x: 280,
        y: 280,
        params: { attack: 0.02, decay: 0.22, sustain: 0.28, release: 0.45, amount: 0.85 },
      },
      { id: 'lfo', kind: 'lfo', x: 280, y: 520, params: { type: 0, width: 0.5, rate: 0.55, amount: 0.4 } },
      { id: 'lp', kind: 'lowpass', x: 488.0324114786305, y: 35.96903950184599, params: { cutoff: 800, q: 0.9 } },
      {
        id: 'delay',
        kind: 'delay',
        x: 694.9296390648943,
        y: 35.66741813195694,
        params: { timeSec: 0.498002, feedback: 0.39519999999999994, mix: 0.426 },
      },
      { id: 'master', kind: 'master', x: 1125.410015693552, y: 57.42217701587087, params: {} },
      { id: 'bb96c8f71601af7a', kind: 'line', x: 648.7519378926737, y: 474.36614797840707, params: {}, data: { monitor: 0 } },
      {
        id: 'f92a8eee75a6112c',
        kind: 'amp',
        x: 861.8457106869686,
        y: 476.6639092048691,
        params: {
          inputGain: 1,
          outputGain: 1,
          irNormalize: 1,
          eqBand0: 0,
          eqBand1: 0,
          eqBand2: 0,
          eqBand3: 0,
          eqBand4: 0,
          reverbDecay: 0.5,
          reverbSize: 1,
          reverbPreDelay: 0,
          reverbBlend: 0,
          reverbTone: 0.7,
          reverbPreAmp: 0,
          eqPostAmp: 0,
          reverbGate: 0,
          stereoMode: 0,
          inputPad: 0,
          invertR: 0,
          channelLink: 1,
          volLink: 1,
          inputGainR: 1,
          outputGainR: 1,
          delayTime: 350,
          delayFeedback: 0.35,
          delayTone: 0.7,
          delayMix: 0,
          delaySync: 0,
          delayDivision: 1,
          delayPingPong: 0,
          delayTape: 0,
          delayDuck: 0,
          delayPlacement: 2,
          delayOscillate: 0,
          delayOscCC: 27,
          morphEnable: 0,
          morphSource: 0,
          morphDepth: 0.75,
          morphThreshold: 0.35,
          morphSensitivity: 0.5,
          morphAttack: 5,
          morphRelease: 120,
          morphInvert: 0,
          morphManual: 0,
          morphTargetAmp: 1,
          morphTargetIR: 1,
        },
      },
      { id: '086a5f53a82081d7', kind: 'tuner', x: 844.6174591543568, y: 814.7774122388303, params: {} },
      { id: 'fcb296f14817d012', kind: 'analyzer', x: 1158.939440317703, y: 813.0895875309886, params: {} },
      {
        id: '57a0f019d3de1983',
        kind: 'looper',
        x: 1117.8624673543845,
        y: 475.4458712338427,
        params: {
          record: 0,
          play: 1,
          overdub: 0,
          undo: 0,
          length: 8,
          threshold: 0.822,
          quantize: 0,
          clear: 0,
          mix: 1,
        },
      },
      {
        id: 'b7f4d682191904ef',
        kind: 'reverb',
        x: 920.1697828707053,
        y: 30.345421783494345,
        params: { size: 1.3879, decay: 0.92, damp: 6792.321314231604, mix: 0.516 },
      },
    ],
    connections: [
      { source: 'keys', sourceOutput: 'cv', target: 'osc', targetInput: 'note' },
      { source: 'keys', sourceOutput: 'gate', target: 'osc', targetInput: 'gate' },
      { source: 'keys', sourceOutput: 'cv', target: 'adsr', targetInput: 'note' },
      { source: 'keys', sourceOutput: 'gate', target: 'adsr', targetInput: 'gate' },
      { source: 'osc', sourceOutput: 'audio', target: 'lp', targetInput: 'input' },
      { source: 'adsr', sourceOutput: 'cv', target: 'lp', targetInput: 'cutoff' },
      { source: 'lfo', sourceOutput: 'cv', target: 'osc', targetInput: 'width' },
      { source: 'lp', sourceOutput: 'audio', target: 'delay', targetInput: 'input' },
      { source: 'bb96c8f71601af7a', sourceOutput: 'audio', target: 'f92a8eee75a6112c', targetInput: 'input' },
      { source: 'f92a8eee75a6112c', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
      { source: 'f92a8eee75a6112c', sourceOutput: 'audio', target: '086a5f53a82081d7', targetInput: 'input' },
      { source: 'f92a8eee75a6112c', sourceOutput: 'audio', target: 'fcb296f14817d012', targetInput: 'input' },
      { source: 'f92a8eee75a6112c', sourceOutput: 'audio', target: '57a0f019d3de1983', targetInput: 'input' },
      { source: '57a0f019d3de1983', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
      { source: 'delay', sourceOutput: 'audio', target: 'b7f4d682191904ef', targetInput: 'input' },
      { source: 'b7f4d682191904ef', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
    ],
  };
}

/**
 * The recorder's performance/record path as a patcher graph. No clips:
 * Line is the armed guitar, Keyboard is the instrument, Clock is the click
 * sidecar (not mixed into Master). Each audio lane is inserts → pan → fader,
 * then they stack into the master bus the way mainMixerNode does.
 */
export function performancePatch(): CratePatch {
  return {
    version: PATCH_VERSION,
    kind: PATCH_KIND,
    transport: { bpm: 120, beatsPerBar: 4, beatUnit: 4 },
    nodes: [
      { id: 'transport', kind: 'transport', x: 36, y: 200, params: { bpm: 120, beatsPerBar: 4, beatUnit: 4 } },
      { id: 'keys', kind: 'keyboard', x: 36, y: 40, params: {} },
      { id: 'synth', kind: 'synth', x: 260, y: 40, params: {} },
      { id: 'gainSyn', kind: 'gain', x: 500, y: 40, params: { gain: 0.7 } },
      { id: 'panSyn', kind: 'stereopan', x: 720, y: 40, params: { pan: -0.35 } },
      { id: 'line', kind: 'line', x: 36, y: 400, params: {}, data: { monitor: 0 } },
      { id: 'amp', kind: 'amp', x: 260, y: 400, params: {} },
      { id: 'ir', kind: 'ir', x: 500, y: 400, params: {} },
      { id: 'comp', kind: 'compressor', x: 720, y: 400, params: {} },
      { id: 'gainGtr', kind: 'gain', x: 940, y: 400, params: { gain: 0.85 } },
      { id: 'panGtr', kind: 'stereopan', x: 1160, y: 400, params: { pan: 0.2 } },
      { id: 'meterGtr', kind: 'meter', x: 1380, y: 400, params: {} },
      { id: 'clock', kind: 'clock', x: 36, y: 740, params: { freq: 2 } },
      { id: 'pulse', kind: 'pulse', x: 260, y: 740, params: { widthSec: 0.008 } },
      { id: 'gainClk', kind: 'gain', x: 500, y: 740, params: { gain: 0.22 } },
      { id: 'limiter', kind: 'limiter', x: 940, y: 740, params: {} },
      { id: 'meterMst', kind: 'meter', x: 1160, y: 740, params: {} },
      { id: 'master', kind: 'master', x: 1380, y: 740, params: {} },
    ],
    connections: [
      { source: 'keys', sourceOutput: 'cv', target: 'synth', targetInput: 'note' },
      { source: 'keys', sourceOutput: 'gate', target: 'synth', targetInput: 'gate' },
      { source: 'synth', sourceOutput: 'audio', target: 'gainSyn', targetInput: 'input' },
      { source: 'gainSyn', sourceOutput: 'audio', target: 'panSyn', targetInput: 'input' },
      { source: 'panSyn', sourceOutput: 'audio', target: 'limiter', targetInput: 'input' },
      { source: 'line', sourceOutput: 'audio', target: 'amp', targetInput: 'input' },
      { source: 'amp', sourceOutput: 'audio', target: 'ir', targetInput: 'input' },
      { source: 'ir', sourceOutput: 'audio', target: 'comp', targetInput: 'input' },
      { source: 'comp', sourceOutput: 'audio', target: 'gainGtr', targetInput: 'input' },
      { source: 'gainGtr', sourceOutput: 'audio', target: 'panGtr', targetInput: 'input' },
      { source: 'panGtr', sourceOutput: 'audio', target: 'meterGtr', targetInput: 'input' },
      { source: 'meterGtr', sourceOutput: 'audio', target: 'limiter', targetInput: 'input' },
      { source: 'clock', sourceOutput: 'cv', target: 'pulse', targetInput: 'input' },
      { source: 'pulse', sourceOutput: 'cv', target: 'gainClk', targetInput: 'input' },
      { source: 'limiter', sourceOutput: 'audio', target: 'meterMst', targetInput: 'input' },
      { source: 'meterMst', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
    ],
  };
}

/**
 * Six sources placed around the listener, feeding one Spatial Master.
 *
 * Built to answer the question the palette does not: where does a Spatial
 * Source's outlet go? It goes to a Spatial Master and nowhere else, and the
 * master's outlet is ordinary stereo that goes to Master like anything else.
 *
 * ## Why plucks and not a drone
 *
 * A steady sine is both unpleasant to sit with and the worst possible signal
 * for this demo. Localizing a sound relies on how a head colours it across a
 * wide band, and on the arrival-time difference at the two ears, which needs
 * a transient to measure. A pure tone gives neither, so it smears: people
 * famously cannot tell whether one is in front of them or behind.
 *
 * So the sources here are pings. A clock fires a short pulse into two combs
 * tuned a fifth apart, which ring for about a second and a half and decay to
 * nothing. Both fire from one clock, so the same transient arrives from two
 * positions at once, which is the clearest demonstration of separation there
 * is.
 *
 * ## Why the reverb is a send, and inside the field
 *
 * The obvious place for a reverb is after the Spatial Master, on the finished
 * stereo. It is cheaper and it is wrong in a way you can hear: the tail never
 * passes through the rotation, so turning your head swings every source
 * around a reverb that stays bolted to your skull. It is reverb in your
 * headphones rather than the room the sources are standing in, and it smears
 * the localization it sits on top of.
 *
 * So the dry sources go straight to their positions, and a send feeds two
 * reverbs whose outputs are themselves Spatial Sources, placed wide left and
 * wide right. The tail is then in the field: it rotates with your head, and
 * it arrives from the sides the way a room does.
 *
 * **Two reverbs rather than one**, because this reverb is mono. Feeding one
 * mono tail to two positions gives a correlated phantom between them, not a
 * diffuse space. Different `size` values decorrelate the two tails, which is
 * what makes it read as a room.
 *
 * ## The levels are measured, not guessed
 *
 * `strike` is 0.25 because the two pings fire together, so their peaks add:
 * rendered offline, 0.3 clipped and 0.25 leaves headroom.
 *
 * `send` is 0.07 because this reverb is built to sit at `mix` 0.28 as an
 * insert, and carries roughly 4x of make-up gain to suit that. Run fully wet
 * as a send it comes back about five times louder than what went in, so the
 * trim is doing real work rather than being decorative.
 *
 * Each source demonstrates one thing:
 *
 * - **Low ping**, front left, fixed. The reference: it never moves.
 * - **High ping**, ahead, with an LFO patched into its `x`. This is the cable
 *   the design exists for, going straight to the AudioParam. The LFO is
 *   slower than the clock, so successive pings land in different places and
 *   you hear the movement as position rather than as wobble.
 * - **Keys**, to the right and behind. Play into the room.
 * - **Bed**, global. Brown noise, low and quiet. Omnidirectional, immune to
 *   head rotation, no distance attenuation.
 * - **Wet left and wet right**, the room itself, wide and slightly above.
 *
 * Turn the master's `yaw` while it plays. Everything swings except the bed,
 * the reverb included, which is the whole point of the send.
 */
export function spatialPatch(): CratePatch {
  return {
    version: PATCH_VERSION,
    kind: PATCH_KIND,
    nodes: [
      // One clock drives both pings, so they arrive together as a dyad.
      { id: 'clock', kind: 'clock', x: 36, y: 120, params: { freq: 0.5 } },
      { id: 'ping', kind: 'pulse', x: 236, y: 120, params: { widthSec: 0.002 } },
      { id: 'strike', kind: 'gain', x: 236, y: 250, params: { gain: 0.25 } },

      // Comb at 165 Hz and 247 Hz: E3 and B3, a fifth apart. The lowpass
      // takes the edge off the attack so it reads as a pluck, not a click.
      //
      // The feedbacks differ because the decay would not otherwise match: a
      // comb loses `feedback` once per cycle, so the higher pitch goes round
      // more often per second and dies sooner at the same setting. 0.985
      // against 0.98 is 0.98^(165/247), which lands both at about 1.5 s.
      { id: 'combLow', kind: 'comb', x: 456, y: 40, params: { freq: 165, feedback: 0.98, mix: 1 } },
      { id: 'lpLow', kind: 'lowpass', x: 456, y: 160, params: { cutoff: 1100, q: 0.7 } },
      { id: 'combHigh', kind: 'comb', x: 456, y: 290, params: { freq: 247, feedback: 0.985, mix: 1 } },
      { id: 'lpHigh', kind: 'lowpass', x: 456, y: 410, params: { cutoff: 1500, q: 0.7 } },

      { id: 'keys', kind: 'keyboard', x: 36, y: 560, params: {} },
      { id: 'osc', kind: 'oscillator', x: 236, y: 560, params: { type: 0, gain: 0.2 } },

      // Brown noise, rolled off low: room tone rather than hiss.
      { id: 'noise', kind: 'noise', x: 236, y: 800, params: { color: 2, gain: 0.05, cutoff: 380 } },

      // Slower than the clock, so each ping lands somewhere new.
      { id: 'lfo', kind: 'lfo', x: 456, y: 540, params: { rate: 0.13, amount: 1 } },

      // The aux send, and two decorrelated tails fed from it.
      { id: 'send', kind: 'gain', x: 456, y: 680, params: { gain: 0.07 } },
      { id: 'reverbL', kind: 'reverb', x: 686, y: 620, params: { size: 0.78, decay: 0.45, damp: 3600, mix: 1 } },
      { id: 'reverbR', kind: 'reverb', x: 686, y: 780, params: { size: 1.05, decay: 0.45, damp: 4200, mix: 1 } },

      // Front left, one metre out: NAMED_POSITIONS['front-left'].
      { id: 'srcLow', kind: 'spatialsource', x: 950, y: 40, params: { x: -0.7, y: 0, z: -0.7 } },
      // Ahead and further, so the LFO swings it fully past you.
      { id: 'srcHigh', kind: 'spatialsource', x: 950, y: 190, params: { x: 0, y: 0, z: -1.6 } },
      // Right and slightly behind.
      { id: 'srcKeys', kind: 'spatialsource', x: 950, y: 340, params: { x: 0.9, y: 0, z: 0.35 } },
      // `global` 1: no position, no rotation, no distance.
      { id: 'srcBed', kind: 'spatialsource', x: 950, y: 490, params: { global: 1 } },
      // The room: wide and a little above, where reflections come from.
      { id: 'srcWetL', kind: 'spatialsource', x: 950, y: 640, params: { x: -1.4, y: 0.2, z: -0.2 } },
      { id: 'srcWetR', kind: 'spatialsource', x: 950, y: 790, params: { x: 1.4, y: 0.2, z: -0.2 } },

      { id: 'spatial', kind: 'spatialmaster', x: 1220, y: 380, params: { yaw: 0, pitch: 0, level: 1 } },
      { id: 'master', kind: 'master', x: 1450, y: 380, params: {} },
    ],
    connections: [
      { source: 'clock', sourceOutput: 'cv', target: 'ping', targetInput: 'input' },
      { source: 'ping', sourceOutput: 'cv', target: 'strike', targetInput: 'input' },
      { source: 'strike', sourceOutput: 'audio', target: 'combLow', targetInput: 'input' },
      { source: 'strike', sourceOutput: 'audio', target: 'combHigh', targetInput: 'input' },
      { source: 'combLow', sourceOutput: 'audio', target: 'lpLow', targetInput: 'input' },
      { source: 'combHigh', sourceOutput: 'audio', target: 'lpHigh', targetInput: 'input' },

      // Dry: straight to a position.
      { source: 'lpLow', sourceOutput: 'audio', target: 'srcLow', targetInput: 'input' },
      { source: 'lpHigh', sourceOutput: 'audio', target: 'srcHigh', targetInput: 'input' },

      // The point of the whole thing: an LFO on a position axis.
      { source: 'lfo', sourceOutput: 'cv', target: 'srcHigh', targetInput: 'x' },

      { source: 'keys', sourceOutput: 'cv', target: 'osc', targetInput: 'note' },
      { source: 'keys', sourceOutput: 'gate', target: 'osc', targetInput: 'gate' },
      { source: 'osc', sourceOutput: 'audio', target: 'srcKeys', targetInput: 'input' },
      { source: 'noise', sourceOutput: 'audio', target: 'srcBed', targetInput: 'input' },

      // Send: everything with a position feeds the room, the bed does not.
      { source: 'lpLow', sourceOutput: 'audio', target: 'send', targetInput: 'input' },
      { source: 'lpHigh', sourceOutput: 'audio', target: 'send', targetInput: 'input' },
      { source: 'osc', sourceOutput: 'audio', target: 'send', targetInput: 'input' },
      { source: 'send', sourceOutput: 'audio', target: 'reverbL', targetInput: 'input' },
      { source: 'send', sourceOutput: 'audio', target: 'reverbR', targetInput: 'input' },
      { source: 'reverbL', sourceOutput: 'audio', target: 'srcWetL', targetInput: 'input' },
      { source: 'reverbR', sourceOutput: 'audio', target: 'srcWetR', targetInput: 'input' },

      // Six sources into one master. Summing B-format is adding channels,
      // so nothing here tells the master where anything is.
      { source: 'srcLow', sourceOutput: 'audio', target: 'spatial', targetInput: 'input' },
      { source: 'srcHigh', sourceOutput: 'audio', target: 'spatial', targetInput: 'input' },
      { source: 'srcKeys', sourceOutput: 'audio', target: 'spatial', targetInput: 'input' },
      { source: 'srcBed', sourceOutput: 'audio', target: 'spatial', targetInput: 'input' },
      { source: 'srcWetL', sourceOutput: 'audio', target: 'spatial', targetInput: 'input' },
      { source: 'srcWetR', sourceOutput: 'audio', target: 'spatial', targetInput: 'input' },

      { source: 'spatial', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
    ],
  };
}

export function isCratePatch(value: unknown): value is CratePatch {
  if (!value || typeof value !== 'object') return false;
  const patch = value as CratePatch;
  return (
    patch.kind === PATCH_KIND &&
    typeof patch.version === 'number' &&
    Array.isArray(patch.nodes) &&
    Array.isArray(patch.connections)
  );
}

export function parsePatch(text: string): CratePatch {
  const parsed = JSON.parse(text) as unknown;
  if (!isCratePatch(parsed)) throw new Error('Not a crate.patch document');
  return parsed;
}

export function stringifyPatch(patch: CratePatch): string {
  return JSON.stringify(patch, null, 2);
}
