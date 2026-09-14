/**
 * `dsp/BitCrusher.h`, line for line.
 *
 * The reference the ASL graph is measured against, not something the graph
 * calls. Arithmetic is double here and float in the AUv3; that costs about
 * 1e-7 and is well under any tolerance the parity tests use.
 */

/** stmlib polyBLEP, from `dsp/StmlibCompat.h`. */
function thisBlepSample(t: number): number {
  return 0.5 * t * t;
}

function nextBlepSample(t: number): number {
  const u = 1 - t;
  return -0.5 * u * u;
}

export class BitCrusher {
  private phase = 0;
  private sample = 0;
  private previousSample = 0;
  private nextSample = 0;

  init(): void {
    this.phase = 0;
    this.sample = 0;
    this.nextSample = 0;
    this.previousSample = 0;
  }

  /** In place, mono. `sampleRateParam` is the already-curved ratio, 1 = native. */
  process(buf: Float32Array, n: number, mix: number, bitDepth: number, sampleRateParam: number): void {
    if (mix < 0.0001) return;

    const quantLevels = Math.pow(2, bitDepth);
    const invQuantLevels = 1 / quantLevels;
    const lsbFloor = 1 / quantLevels;

    const frequency = Math.min(1, Math.max(0.001, sampleRateParam));

    let sample = this.sample;
    let phase = this.phase;

    // At or below 8 bits the crusher switches character wholesale: truncation
    // instead of rounding, and a raw hold instead of a BLEP-smoothed one.
    const harshMode = bitDepth <= 8;

    let previousSample = this.previousSample;
    let nextSample = this.nextSample;

    for (let i = 0; i < n; i++) {
      const dry = buf[i]!;
      let input = dry;

      if (bitDepth < 15.9) {
        let scaled = (input * 0.5 + 0.5) * quantLevels;
        if (harshMode) {
          scaled = Math.floor(scaled);
          if (scaled >= quantLevels) scaled = quantLevels - 1;
        } else {
          scaled = Math.floor(scaled + 0.5);
        }
        input = scaled * invQuantLevels * 2 - 1;
      }

      if (frequency < 0.999) {
        if (harshMode) {
          phase += frequency;
          if (phase >= 1) {
            phase -= 1;
            sample = input;
          }
          input = sample;
        } else {
          let thisSample = nextSample;
          nextSample = 0;
          phase += frequency;
          if (phase >= 1) {
            phase -= 1;
            const t = phase / frequency;
            const newSample = previousSample + (input - previousSample) * (1 - t);
            const discontinuity = newSample - sample;
            thisSample += discontinuity * thisBlepSample(t);
            nextSample += discontinuity * nextBlepSample(t);
            sample = newSample;
          }
          nextSample += sample;
          previousSample = input;
          input = thisSample;
        }
      }

      if (bitDepth < 15.9) {
        const dryAbs = Math.abs(dry);
        if (dryAbs < lsbFloor) {
          const g = dryAbs / lsbFloor;
          input = dry * (1 - g) + input * g;
        }
      }

      buf[i] = dry * (1 - mix) + input * mix;
    }

    this.phase = phase;
    this.sample = sample;
    this.nextSample = nextSample;
    this.previousSample = previousSample;
  }
}
