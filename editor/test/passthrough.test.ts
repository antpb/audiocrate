import { describe, expect, it } from 'vitest';
import { passthroughLinks, type GraphLink } from '../src/passthrough';

function link(
  source: string,
  sourceOutput: string,
  target: string,
  targetInput: string,
): GraphLink {
  return { source, sourceOutput, target, targetInput };
}

describe('passthroughLinks', () => {
  it('rewires stacked inputs through an insert into Master', () => {
    const links = [
      link('pan0', 'audio', 'limiter', 'input'),
      link('pan1', 'audio', 'limiter', 'input'),
      link('pan2', 'audio', 'limiter', 'input'),
      link('limiter', 'audio', 'master', 'input'),
    ];
    expect(passthroughLinks('limiter', links)).toEqual([
      link('pan0', 'audio', 'master', 'input'),
      link('pan1', 'audio', 'master', 'input'),
      link('pan2', 'audio', 'master', 'input'),
    ]);
  });

  it('fans a single input out to every destination', () => {
    const links = [
      link('gain', 'audio', 'eq', 'input'),
      link('eq', 'audio', 'master', 'input'),
      link('eq', 'audio', 'meter', 'input'),
    ];
    expect(passthroughLinks('eq', links)).toEqual([
      link('gain', 'audio', 'master', 'input'),
      link('gain', 'audio', 'meter', 'input'),
    ]);
  });

  it('drops sidechain and CV inlets', () => {
    const links = [
      link('keys', 'cv', 'synth', 'note'),
      link('keys', 'gate', 'synth', 'gate'),
      link('line', 'audio', 'amp', 'input'),
      link('amp', 'audio', 'master', 'input'),
    ];
    expect(passthroughLinks('amp', links)).toEqual([link('line', 'audio', 'master', 'input')]);
    expect(passthroughLinks('synth', links)).toEqual([]);
  });

  it('skips a cable that already exists and will not loop', () => {
    const links = [
      link('gain', 'audio', 'eq', 'input'),
      link('eq', 'audio', 'gain', 'input'),
      link('eq', 'audio', 'master', 'input'),
      link('gain', 'audio', 'master', 'input'),
    ];
    expect(passthroughLinks('eq', links)).toEqual([]);
  });

  it('is empty when the node is a sink or a source', () => {
    expect(passthroughLinks('master', [link('gain', 'audio', 'master', 'input')])).toEqual([]);
    expect(passthroughLinks('line', [link('line', 'audio', 'amp', 'input')])).toEqual([]);
  });
});
