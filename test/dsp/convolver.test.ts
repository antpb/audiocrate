import { describe, expect, it } from 'vitest';
import { PartitionedConvolver, convolveDirect } from '../../src/dsp/convolver';

describe('convolveDirect', () => {
  it('is the definition: y[n] = sum_k ir[k] x[n-k]', () => {
    const x = [1, 0, 0, 0];
    const ir = [0.5, 0.25, 0.125];
    const y = convolveDirect(x, ir);
    expect([...y]).toEqual([0.5, 0.25, 0.125, 0, 0, 0]);
  });
});

describe('PartitionedConvolver', () => {
  it('is a passthrough with no IR loaded', () => {
    const conv = new PartitionedConvolver();
    const out = new Float32Array(4);
    conv.process([0.2, -0.4, 0.6, 0], out);
    expect(out[0]).toBeCloseTo(0.2, 5);
    expect(out[1]).toBeCloseTo(-0.4, 5);
    expect(out[2]).toBeCloseTo(0.6, 5);
    expect(out[3]).toBeCloseTo(0, 5);
    expect(conv.latencySamples).toBe(0);
  });

  it('a unit-impulse IR reproduces a hop-aligned input', () => {
    const partSize = 32;
    const conv = new PartitionedConvolver();
    conv.setup([1], partSize);
    expect(conv.latencySamples).toBe(partSize);

    const input = new Float32Array(partSize * 3);
    for (let i = 0; i < input.length; i++) input[i] = ((i * 17) % 13) / 13 - 0.5;
    const out = new Float32Array(input.length);
    conv.process(input, out);

    for (let i = 0; i < input.length; i++) {
      expect(out[i]).toBeCloseTo(input[i]!, 5);
    }
  });

  it('matches direct convolution on a hop-aligned block', () => {
    const partSize = 32;
    const ir = [0.8, -0.3, 0.15, 0.05];
    const input = new Float32Array(partSize * 2);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * 0.3);

    const conv = new PartitionedConvolver();
    conv.setup(ir, partSize);
    const out = new Float32Array(input.length);
    conv.process(input, out);

    const direct = convolveDirect(input, ir);
    for (let i = 0; i < input.length; i++) {
      expect(out[i]).toBeCloseTo(direct[i]!, 5);
    }
  });

  it('sample-by-sample leads by one hop, then matches the block path', () => {
    const partSize = 32;
    const ir = [1, 0.5];
    const input = new Float32Array(partSize * 2);
    for (let i = 0; i < input.length; i++) input[i] = i % 2 === 0 ? 0.4 : -0.2;

    const block = new PartitionedConvolver();
    block.setup(ir, partSize);
    const fromBlock = new Float32Array(input.length);
    block.process(input, fromBlock);

    const sample = new PartitionedConvolver();
    sample.setup(ir, partSize);
    const fromSample = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) fromSample[i] = sample.processSample(input[i]!);

    for (let i = 0; i < partSize - 1; i++) expect(fromSample[i]).toBeCloseTo(0, 6);
    for (let i = 0; i < input.length - (partSize - 1); i++) {
      expect(fromSample[i + partSize - 1]).toBeCloseTo(fromBlock[i]!, 5);
    }
  });
});
