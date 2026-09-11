/**
 * A resonant stone: an idiophone excited by wind, or struck.
 *
 * There are no audio files. Forty stones share one description and differ
 * by parameters rather than by separate recordings.
 *
 * ## Why there is no noise generator
 *
 * XR Publisher requires a world identical for every visitor: placement and
 * generated content come from seeded PRNGs, and `Math.random()` is banned
 * for anything that should persist. Audiocrate's `noise` and `random` nodes call
 * `Math.random()` per sample, so a graph containing one is not reproducible
 * even against itself.
 *
 * The excitation is sample-and-holds latching slow oscillators at rates that
 * do not divide into each other. That is not white noise: it is a
 * quasi-periodic stepped signal, and a pure function of its parameters. The
 * same stone sounds the same for every visitor. Per-stone variation comes
 * from `spawn.rng`.
 */
import { AudioMaterial, clip, env, filter, impulse, lfo, mix, param, sampleHold, tap } from '../crate';

/**
 * Partial ratios of a struck bar. Inharmonic; 1:2:3 would be a pipe.
 */
const PARTIALS = [1, 2.76, 5.4] as const;

export const resonantStoneMaterial = new AudioMaterial({
  name: 'ResonantStone',
  params: {
    /** Fundamental. Per-stone, drawn from a scale so a hillside is in key. */
    pitch: param.range(90, 1400, { default: 220, unit: 'Hz', curve: 'log' }),
    /**
     * How hard the wind is blowing on this stone, 0..1. Driven per frame
     * from `getWeatherAt` at the stone's position.
     */
    wind: param.range(0, 1, { default: 0.25 }),
    /** How much of the upper partials survive. A big stone is duller. */
    brightness: param.range(0, 1, { default: 0.5 }),
    /** Resonator Q. Higher rings longer and is closer to a pitched tone. */
    ring: param.range(4, 90, { default: 34, curve: 'log' }),
    /**
     * The two excitation rates. These are the per-stone seed: two stones with
     * different rates have different grain, and both are deterministic.
     *
     * Parameters rather than graph constants specifically so that one
     * compiled graph serves every stone. A graph constant would mean a
     * distinct `ASLGraphDescriptor` per spawn, which is a distinct compiled
     * voice, which throws away the sharing that makes this affordable.
     */
    grain: param.range(180, 2600, { default: 900, unit: 'Hz', curve: 'log' }),
    grainRatio: param.range(1.31, 4.77, { default: 2.19 }),
  },
  automatable: ['wind', 'brightness', 'pitch'],
  polyphony: 1,
  // A control-rate mono voice. The panner puts it in space, so rendering the
  // graph twice to produce two identical channels would be exactly double the
  // work for no audible difference.
  channels: 1,
  graph: ({ velocity, params }) => {
    // Excitation. Three sample-and-holds, each latching a slow oscillator at
    // a rate that is not a multiple of the oscillator's, so the latched
    // sequence walks rather than repeating. Summing three at spread ratios
    // fills in the gaps between their periods.
    const rate = params.grain;
    const grit = mix(
      sampleHold(lfo({ rate: rate.mul(0.0037) }), { freq: rate }).mul(0.5),
      sampleHold(lfo({ rate: rate.mul(0.0121) }), { freq: rate.mul(params.grainRatio) }).mul(0.32),
      sampleHold(lfo({ rate: rate.mul(0.0053), shape: 'triangle' }), {
        freq: rate.mul(params.grainRatio).mul(1.61),
      }).mul(0.18),
    );

    // Wind is gusty, not steady. Two slow LFOs at unrelated rates, rectified
    // into a positive envelope, so gusts arrive irregularly without ever
    // repeating on a period short enough to hear as a loop.
    const gust = mix(lfo({ rate: 0.073, shape: 'triangle' }).mul(0.6), lfo({ rate: 0.031 }).mul(0.4))
      .range(0, 1)
      .mul(params.wind);

    // A strike is two things, and writing it as one is a bug worth recording
    // because the symptom is silence rather than a wrong sound.
    //
    // The obvious spelling is `impulse().mul(envelope)`. It renders nothing.
    // `impulse()` with no gate is armed at construction and fires on the very
    // first sample of the voice, and an envelope with a 1 ms attack is still
    // at zero on that sample, so the product is zero and the only thing left
    // is the tail of an envelope multiplying silence.
    //
    // Physically the two halves are separate anyway: the click of contact,
    // which is instantaneous and scales with how hard you hit it, and the
    // brief scrape of the striker on the surface, which is what the envelope
    // actually describes.
    const strikeEnv = env.adsr({ a: 0.0005, d: 0.35, s: 0, r: 0.35 }).trigger(velocity);
    const strike = impulse().mul(velocity).mul(10).add(grit.mul(strikeEnv).mul(0.8));

    const excitation = grit.mul(gust).add(strike);

    // The resonator. Three high-Q bandpasses in parallel at bar-partial
    // ratios: this is the stone. `brightness` fades the upper two rather than
    // filtering the sum, so a dull stone is genuinely missing its upper
    // partials instead of having them rolled off, which is the difference
    // between a big rock and a small rock behind a blanket.
    const bright = params.brightness;
    const body = mix(
      filter.svf(excitation, { cutoff: params.pitch, q: params.ring, mode: 'bandpass' }),
      filter
        .svf(excitation, {
          cutoff: params.pitch.mul(PARTIALS[1]),
          q: params.ring.mul(0.8),
          mode: 'bandpass',
        })
        .mul(bright.mul(0.55)),
      filter
        .svf(excitation, {
          cutoff: params.pitch.mul(PARTIALS[2]),
          q: params.ring.mul(0.6),
          mode: 'bandpass',
        })
        .mul(bright.mul(bright).mul(0.3)),
    );

    // A high-Q resonator hit by an impulse can peak well past 1. Soft clip
    // rather than a limiter: this is one voice among many going into a
    // spatial mix. A compressor here would pump against the wind envelope.
    const out = clip(body.mul(0.5), { drive: 1.6 });

    // Measured inside the graph, before the panner, so the stone's glow
    // tracks the stone. The engine's own analyser hears the entire spatial
    // mix, which would make every stone pulse to the sum of all of them.
    return tap.meter(out, { id: 'stone' });
  },
});
