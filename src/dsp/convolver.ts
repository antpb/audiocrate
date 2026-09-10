import { fftRadix2 } from './fft';

/**
 * Overlap-save partitioned convolution. Same scheme as the native
 * `IRConvolver` (power-of-two hop, discard the aliased half), but the
 * scale is the mathematical 1/N rather than the amp product's 2/N.
 *
 * Latency is exactly `partSize` samples once an IR is loaded. That is the
 * hop, not a bug: the first output block cannot exist until one hop of
 * input has been seen. Report it for plugin delay compensation.
 *
 * Process accepts any block size, including 1, so the same object serves
 * `renderSample` and `renderBlock`.
 */
export const IR_PARTITION_SIZE = 512;

export class PartitionedConvolver {
  private partSize = 0;
  private fftSize = 0;
  private numParts = 0;
  private irRe: Float64Array[] = [];
  private irIm: Float64Array[] = [];
  private inRe: Float64Array[] = [];
  private inIm: Float64Array[] = [];
  private history: Float32Array = new Float32Array(0);
  private carry: Float32Array = new Float32Array(0);
  private carryCount = 0;
  private writeIdx = 0;
  private outRing: Float32Array = new Float32Array(0);
  private ringWrite = 0;
  private ringRead = 0;
  private ringAvail = 0;
  private ready = false;

  get latencySamples(): number {
    return this.ready ? this.partSize : 0;
  }

  get isReady(): boolean {
    return this.ready;
  }

  setup(ir: ArrayLike<number>, partSize: number = IR_PARTITION_SIZE): void {
    this.teardown();
    if (ir.length <= 0 || partSize < 32 || (partSize & (partSize - 1)) !== 0) return;

    this.partSize = partSize;
    this.fftSize = partSize * 2;
    this.numParts = Math.ceil(ir.length / partSize);

    const timeRe = new Float64Array(this.fftSize);
    const timeIm = new Float64Array(this.fftSize);
    this.irRe = [];
    this.irIm = [];
    this.inRe = [];
    this.inIm = [];
    for (let p = 0; p < this.numParts; p++) {
      timeRe.fill(0);
      timeIm.fill(0);
      const offset = p * partSize;
      const count = Math.min(partSize, ir.length - offset);
      for (let i = 0; i < count; i++) timeRe[i] = ir[offset + i]!;
      fftRadix2(timeRe, timeIm, false);
      this.irRe.push(Float64Array.from(timeRe));
      this.irIm.push(Float64Array.from(timeIm));
      this.inRe.push(new Float64Array(this.fftSize));
      this.inIm.push(new Float64Array(this.fftSize));
    }

    this.history = new Float32Array(partSize);
    this.carry = new Float32Array(partSize);
    this.carryCount = 0;
    this.writeIdx = 0;
    this.outRing = new Float32Array(this.fftSize + partSize);
    this.ringWrite = 0;
    this.ringRead = 0;
    this.ringAvail = 0;
    this.ready = true;
  }

  reset(): void {
    if (!this.ready) return;
    for (let p = 0; p < this.numParts; p++) {
      this.inRe[p]!.fill(0);
      this.inIm[p]!.fill(0);
    }
    this.history.fill(0);
    this.carry.fill(0);
    this.outRing.fill(0);
    this.carryCount = 0;
    this.writeIdx = 0;
    this.ringWrite = 0;
    this.ringRead = 0;
    this.ringAvail = 0;
  }

  process(input: ArrayLike<number>, output: Float32Array): void {
    const n = output.length;
    if (!this.ready) {
      for (let i = 0; i < n; i++) output[i] = input[i] ?? 0;
      return;
    }

    let consumed = 0;
    while (consumed < n) {
      const toCopy = Math.min(n - consumed, this.partSize - this.carryCount);
      for (let i = 0; i < toCopy; i++) this.carry[this.carryCount + i] = input[consumed + i] ?? 0;
      consumed += toCopy;
      this.carryCount += toCopy;
      if (this.carryCount === this.partSize) {
        this.processPartition(this.carry);
        this.carryCount = 0;
      }
    }

    const drain = Math.min(n, this.ringAvail);
    for (let i = 0; i < drain; i++) {
      output[i] = this.outRing[this.ringRead]!;
      this.ringRead = (this.ringRead + 1) % this.outRing.length;
    }
    this.ringAvail -= drain;
    if (drain < n) output.fill(0, drain);
  }

  processSample(input: number): number {
    const out = new Float32Array(1);
    this.process([input], out);
    return out[0]!;
  }

  private processPartition(chunk: Float32Array): void {
    const P = this.partSize;
    const N = this.fftSize;
    const timeRe = new Float64Array(N);
    const timeIm = new Float64Array(N);
    for (let i = 0; i < P; i++) timeRe[i] = this.history[i]!;
    for (let i = 0; i < P; i++) timeRe[P + i] = chunk[i]!;
    this.history.set(chunk);

    fftRadix2(timeRe, timeIm, false);
    this.inRe[this.writeIdx]!.set(timeRe);
    this.inIm[this.writeIdx]!.set(timeIm);

    const accRe = new Float64Array(N);
    const accIm = new Float64Array(N);
    for (let p = 0; p < this.numParts; p++) {
      const slot = (this.writeIdx - p + this.numParts) % this.numParts;
      const aRe = this.inRe[slot]!;
      const aIm = this.inIm[slot]!;
      const bRe = this.irRe[p]!;
      const bIm = this.irIm[p]!;
      for (let i = 0; i < N; i++) {
        accRe[i]! += aRe[i]! * bRe[i]! - aIm[i]! * bIm[i]!;
        accIm[i]! += aRe[i]! * bIm[i]! + aIm[i]! * bRe[i]!;
      }
    }

    fftRadix2(accRe, accIm, true);
    const ringSize = this.outRing.length;
    for (let i = 0; i < P; i++) {
      this.outRing[this.ringWrite] = accRe[P + i]!;
      this.ringWrite = (this.ringWrite + 1) % ringSize;
    }
    this.ringAvail += P;
    this.writeIdx = (this.writeIdx + 1) % this.numParts;
  }

  private teardown(): void {
    this.ready = false;
    this.irRe = [];
    this.irIm = [];
    this.inRe = [];
    this.inIm = [];
  }
}

/** Direct FIR, the definition of convolution. Zero latency. Reference for tests. */
export function convolveDirect(input: ArrayLike<number>, ir: ArrayLike<number>): Float32Array {
  const y = new Float32Array(input.length + ir.length - 1);
  for (let n = 0; n < y.length; n++) {
    let sum = 0;
    const kMax = Math.min(n, ir.length - 1);
    const kMin = Math.max(0, n - (input.length - 1));
    for (let k = kMin; k <= kMax; k++) {
      sum += ir[k]! * input[n - k]!;
    }
    y[n] = sum;
  }
  return y;
}
