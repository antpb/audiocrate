/**
 * `env.adsr` used to render NaN when called with the same option names its
 * sibling `env.dahdsr` uses.
 *
 * Found by writing a consumer smoke test in plain JavaScript against the
 * published tarball, which is the only place the bug is reachable: the
 * TypeScript signature made the terse spelling mandatory, so nothing inside
 * this repo could hit it. A JavaScript caller got an unbroken stream of NaN,
 * no error, and nothing to search for.
 *
 * The fix lives in the builder, not the interpreter, so a correct call emits
 * exactly the node it always did and the golden snapshot is untouched.
 */
import { describe, expect, it } from 'vitest';
import { env, osc } from '../../src/asl/builders';
import { AudioMaterial } from '../../src/graph/AudioMaterial';
import { OfflineRenderer } from '../../src/renderers/OfflineRenderer';

/**
 * Note the `.trigger(1)`. `env.adsr` defaults its trigger to 0, so a bare
 * `env.adsr({...})` renders silence until a velocity is bound. That is
 * deliberate (velocity is meant to come from the voice, and a default of 1
 * would let an AudioMaterial silently ignore velocity), and it is why these tests
 * assert audio rather than assuming it.
 */
const render = (build: () => ReturnType<typeof env.adsr>) =>
  OfflineRenderer.render(
    new AudioMaterial({ name: 'probe', params: {}, graph: () => osc({ freq: 440, type: 'sine' }).mul(build()) }).graph,
    { duration: 0.05, sampleRate: 48000 },
  ).samples;

const anyNaN = (s: Float32Array) => Array.from(s).some(Number.isNaN);
const peak = (s: Float32Array) => Array.from(s).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('env.adsr options', () => {
  it('renders silence with no velocity bound, which is why .trigger matters', () => {
    const out = render(() => env.adsr({ a: 0.005, d: 0.4, s: 0.5, r: 0.1 }) as never);
    expect(anyNaN(out)).toBe(false);
    expect(peak(out)).toBe(0);
  });

  it('renders audio for the terse spelling', () => {
    const out = render(() => env.adsr({ a: 0.005, d: 0.4, s: 0, r: 0.1 }).trigger(1));
    expect(anyNaN(out)).toBe(false);
    expect(peak(out)).toBeGreaterThan(0.001);
  });

  it('renders audio for the spelled-out names dahdsr uses', () => {
    // This is the case that used to be silent NaN.
    const out = render(() => env.adsr({ attack: 0.005, decay: 0.4, sustain: 0, release: 0.1 }).trigger(1));
    expect(anyNaN(out)).toBe(false);
    expect(peak(out)).toBeGreaterThan(0.001);
  });

  it('gives both spellings identical output', () => {
    const terse = render(() => env.adsr({ a: 0.005, d: 0.4, s: 0.25, r: 0.1 }).trigger(1));
    const long = render(() => env.adsr({ attack: 0.005, decay: 0.4, sustain: 0.25, release: 0.1 }).trigger(1));
    expect(Array.from(long)).toEqual(Array.from(terse));
  });

  it('emits exactly the node shape it always did, so serialized graphs do not move', () => {
    // The golden snapshot and the Swift conformance fixture both hash the
    // serialized graph. If this builder started emitting extra keys or a
    // different key order, both would break for no audible reason.
    const node = env.adsr({ a: 0.002, d: 0.01, s: 0.5, r: 0.05 }).node;
    expect(Object.keys(node.params)).toEqual(['a', 'd', 's', 'r']);
    expect(node.params).toEqual({ a: 0.002, d: 0.01, s: 0.5, r: 0.05 });
  });

  it('defaults to the same shape dahdsr defaults to', () => {
    expect(env.adsr().node.params).toEqual({ a: 0.005, d: 0.1, s: 0.7, r: 0.2 });
  });

  it('throws on a typo rather than silently ignoring it', () => {
    // @ts-expect-error deliberately wrong, which is the whole point
    expect(() => env.adsr({ atack: 0.01 })).toThrow(/unknown option "atack"/);
  });

  it('throws on a non-finite time', () => {
    expect(() => env.adsr({ a: Number.NaN, d: 0.1, s: 0.5, r: 0.2 })).toThrow(/attack must be a finite number/);
    // @ts-expect-error a string is the classic form-input mistake
    expect(() => env.adsr({ a: '0.01', d: 0.1, s: 0.5, r: 0.2 })).toThrow(/attack must be a finite number/);
  });
});
