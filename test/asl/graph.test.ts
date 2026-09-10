import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { ASLValue } from '../../src/asl/ASLValue';
import { uniform } from '../../src/asl/builders';

describe('ASL.node input tracking', () => {
  it('only records the input names the builder actually reads, in access order', () => {
    const graph = ASL.node(({ velocity, note }) => uniform(note).toFrequency().mul(uniform(velocity)));
    expect(graph.inputs).toEqual(['velocity', 'note']);
  });

  it('records nothing for a builder that reads no inputs', () => {
    const graph = ASL.node(() => uniform(1).add(1));
    expect(graph.inputs).toEqual([]);
  });

  it('gives the same input name the same underlying node on repeated access', () => {
    const graph = ASL.node(({ note }) => uniform(note).add(uniform(note)));
    // both operands of the add should be the exact same param node instance
    expect(graph.output.inputs.a).toBe(graph.output.inputs.b);
  });

  it('rejects a builder that does not return an ASLValue', () => {
    expect(() => ASL.node(() => 5 as unknown as ASLValue)).toThrow(TypeError);
  });
});
