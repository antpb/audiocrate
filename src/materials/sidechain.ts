/**
 * Materials with two live audio inputs.
 *
 * A track insert has always had exactly one signal to work on, which quietly
 * ruled out an entire family: everything whose behaviour depends on a second
 * signal rather than a second number. Ducking a bass under a kick, gating a
 * room mic from a snare close mic, multiplying one voice by another, mixing
 * a send back in. `audio.sidechain()` (`asl/ports.ts`) is that second input,
 * and a renderer gives the AudioMaterial a second real audio input when its graph
 * reads one. `AudioMaterial.setAudioSource('sidechain', ...)` says where from.
 *
 * A signal times a control voltage and a signal times another signal are the
 * same node, and only the source of the second operand differs. Audiocrate's split
 * is the same one, made explicit by whether the operand is a `param` or a
 * `port`.
 *
 * A sidechain port with nothing connected reads 0. An unconnected
 * `audioMultiply` goes silent (0 times anything). An unconnected `ducker`
 * stops ducking. Neither throws.
 *
 * Every one of these ships as a factory as well as a ready-made instance,
 * unlike the plain ASL Materials next door. Routing is per-instance state:
 * two tracks ducking off two different kicks are two Materials, and sharing
 * the module-level singleton between them would silently make the second
 * `setAudioSource` win on both.
 */
import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { compare, compressor, envFollow, logic, mix, panLaw, pulse, select, uniform } from '../asl/builders';

/**
 * Compression keyed off another track. Identical to `compressor` except for
 * where the detector looks, which is the whole idea.
 */
export function createSidechainCompressorMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'SidechainCompressor',
    kind: 'sidechaincomp',
    params: {
      threshold: param.range(0, 1, { default: 0.5 }),
      ratio: param.range(1, 20, { default: 4 }),
      attack: param.range(0.0005, 0.5, { default: 0.005, unit: 's', curve: 'exp' }),
      release: param.range(0.005, 2, { default: 0.05, unit: 's', curve: 'exp' }),
    },
    automatable: ['threshold', 'ratio', 'attack', 'release'],
    graph: ({ input, audio, params }) =>
      compressor(input, {
        threshold: params.threshold,
        ratio: params.ratio,
        attack: params.attack,
        release: params.release,
        sidechain: audio.sidechain(),
      }),
  });
}

/**
 * The blunter cousin: turn the signal down in proportion to how loud the
 * sidechain is, with no threshold or knee. This is what most people actually
 * want when they say "duck the music under the voice", and it is one
 * multiply rather than a gain computer.
 */
export function createDuckerMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'Ducker',
    kind: 'ducker',
    params: {
      amount: param.range(0, 1, { default: 0.8 }),
      attack: param.range(0.0005, 0.5, { default: 0.01, unit: 's', curve: 'exp' }),
      release: param.range(0.005, 2, { default: 0.2, unit: 's', curve: 'exp' }),
    },
    automatable: ['amount', 'attack', 'release'],
    graph: ({ input, audio, params }) => {
      const key = envFollow(audio.sidechain(), { attack: params.attack, release: params.release });
      // The follower is an absolute-value envelope, so for a key inside full
      // scale the multiplier stays within [1 - amount, 1] by construction.
      const duck = uniform(1).add(key.mul(params.amount).mul(-1));
      return input.mul(duck);
    },
  });
}

/**
 * Passes the signal only while the sidechain is above threshold. A room mic
 * opened by the close mic, which is the standard way to keep a drum kit's
 * bleed under control.
 */
export function createSidechainGateMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'SidechainGate',
    kind: 'sidechaingate',
    params: {
      threshold: param.range(0, 1, { default: 0.1 }),
      attack: param.range(0.0005, 0.5, { default: 0.002, unit: 's', curve: 'exp' }),
      release: param.range(0.005, 2, { default: 0.1, unit: 's', curve: 'exp' }),
      hold: param.range(0, 0.5, { default: 0, unit: 's' }),
    },
    automatable: ['threshold', 'attack', 'release', 'hold'],
    graph: ({ input, audio, params }) => {
      const key = envFollow(audio.sidechain(), { attack: params.attack, release: params.release });
      const open = compare(key, { threshold: params.threshold, mode: 'gt' });
      return input.mul(logic.or(open, pulse(open, { widthSec: params.hold })));
    },
  });
}

/**
 * One signal times another. Ring modulation when both are audio, an
 * amplitude envelope when the second is slow, a VCA when it is a control
 * signal. The `ringMod` AudioMaterial is this against an oscillator crate
 * generates itself; this is the version where the modulator is yours.
 */
export function createAudioMultiplyMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'AudioMultiply',
    kind: 'audiomultiply',
    params: {
      mix: param.range(0, 1, { default: 1 }),
    },
    automatable: ['mix'],
    graph: ({ input, audio, params }) => {
      const wet = input.mul(audio.sidechain());
      const dry = input.mul(uniform(1).add(params.mix.mul(-1)));
      return dry.add(wet.mul(params.mix));
    },
  });
}

/** Sums a second input in at a level. The return leg of a send. */
export function createAudioMixMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'AudioMix',
    kind: 'audiomix',
    params: {
      level: param.range(0, 2, { default: 1 }),
    },
    automatable: ['level'],
    graph: ({ input, audio, params }) => mix(input, audio.sidechain().mul(params.level)),
  });
}

/**
 * Equal-power crossfade between the two inputs. At 0 the insert signal is
 * alone, at 1 the sidechain is, and the sum of powers stays constant across
 * the sweep instead of dipping in the middle the way a linear blend does.
 */
export function createCrossfadeMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'Crossfade',
    kind: 'crossfade',
    params: {
      position: param.range(0, 1, { default: 0.5 }),
    },
    automatable: ['position'],
    graph: ({ input, audio, params }) => {
      // A crossfade is a pan between two sources, so it is the pan law with a
      // constant fed through it: `panLaw(1, ...)` is exactly cos and sin of
      // the quarter turn. Reusing the node keeps one curve in the codebase
      // rather than a second, approximate one written out here.
      const pan = params.position.mul(2).add(-1);
      const dryGain = panLaw(1, { pan, channel: 'left' });
      const wetGain = panLaw(1, { pan, channel: 'right' });
      return input.mul(dryGain).add(audio.sidechain().mul(wetGain));
    },
  });
}

/**
 * Hard A/B between the two inputs. `which` above 0.5 takes the sidechain.
 * A switch, not a fade: use it for source selection, not for automating a
 * transition, where it will click.
 */
export function createInputSelectMaterial(): AudioMaterial {
  return new AudioMaterial({
    name: 'InputSelect',
    kind: 'inputselect',
    params: {
      which: param.toggle({ default: false, labels: ['Input', 'Sidechain'] }),
    },
    automatable: ['which'],
    graph: ({ input, audio, params }) => select(input, audio.sidechain(), { which: params.which }),
  });
}

export const sidechainCompressorMaterial = createSidechainCompressorMaterial();
export const duckerMaterial = createDuckerMaterial();
export const sidechainGateMaterial = createSidechainGateMaterial();
export const audioMultiplyMaterial = createAudioMultiplyMaterial();
export const audioMixMaterial = createAudioMixMaterial();
export const crossfadeMaterial = createCrossfadeMaterial();
export const inputSelectMaterial = createInputSelectMaterial();

export const sidechainMaterials = [
  sidechainCompressorMaterial,
  duckerMaterial,
  sidechainGateMaterial,
  audioMultiplyMaterial,
  audioMixMaterial,
  crossfadeMaterial,
  inputSelectMaterial,
] as const;

export const sidechainMaterialFactories = [
  createSidechainCompressorMaterial,
  createDuckerMaterial,
  createSidechainGateMaterial,
  createAudioMultiplyMaterial,
  createAudioMixMaterial,
  createCrossfadeMaterial,
  createInputSelectMaterial,
] as const;
