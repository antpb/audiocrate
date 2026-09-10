import { describe, expect, it } from 'vitest';
import { fingerprint, insertCases, sourceCases } from '../../src/asl/goldenCases';

describe('golden audio', () => {
  it('sources render exactly what they rendered before', () => {
    const table: Record<string, string> = {};
    for (const [name, graph] of Object.entries(sourceCases)) table[name] = fingerprint(graph, false);
    expect(table).toMatchSnapshot();
  });

  it('inserts render exactly what they rendered before', () => {
    const table: Record<string, string> = {};
    for (const [name, graph] of Object.entries(insertCases)) table[name] = fingerprint(graph, true);
    expect(table).toMatchSnapshot();
  });
});
