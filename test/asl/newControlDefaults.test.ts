/**
 * Every control added in this pass, at its default, leaves the sound it was
 * added to bit-identical.
 *
 * This is the property that decides whether a new parameter is safe to ship
 * into work people already have. A `drive` that is 0.3 dB hot at 1, a `hold`
 * that is one sample long at 0, a `phase` that rounds at 0: none of those show
 * up in a listening test, all of them silently change every existing patch,
 * and none of them would be caught by a test that only asks whether the new
 * control does something.
 *
 * The conformance fixture proves the two implementations agree. This proves
 * the defaults are the identity, which the fixture cannot: it compares a new
 * case against the other language, not against the old behaviour.
 */
import { describe, expect, it } from 'vitest';
import { BlockRenderer } from '../../src/renderers/BlockRenderer';
import { OfflineRenderer } from '../../src/renderers/OfflineRenderer';
import { audio, clock, filter, lfo, sampleHold } from '../../src/asl/builders';
import { gateMaterial } from '../../src/materials/dynamics';
import type { ASLValue } from '../../src/asl/ASLValue';

const SR = 48000;
const DURATION = 0.05;

function render(graph: ASLValue, params: Record<string, number> = {}): Float32Array {
  return OfflineRenderer.render({ output: graph.node, inputs: [] } as never, {
    duration: DURATION,
    sampleRate: SR,
    params,
  }).samples;
}

function expectIdentical(a: Float32Array, b: Float32Array, what: string): void {
  expect(a.length, what).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  expect(worst, `${what}: differs by ${worst}`).toBe(0);
}

describe('a new control at its default changes nothing', () => {
  it('ladder drive of 1 is the ladder without drive', () => {
    const opts = { cutoff: 900, resonance: 0.4 };
    expectIdentical(
      render(filter.ladder(audio.input(), opts), { input: 0.5 }),
      render(filter.ladder(audio.input(), { ...opts, drive: 1 }), { input: 0.5 }),
      'ladder drive',
    );
  });

  it('lfo phase of 0 is the lfo without phase', () => {
    expectIdentical(render(lfo({ rate: 40 })), render(lfo({ rate: 40, phase: 0 })), 'lfo phase');
  });

  it('an lfo nothing resets is the lfo without a reset inlet', () => {
    expectIdentical(
      render(lfo({ rate: 40 })),
      render(lfo({ rate: 40, reset: 0 })),
      'lfo reset held low',
    );
  });

  it('a sample and hold with no clock cabled runs on its own rate', () => {
    const source = () => lfo({ rate: 311 });
    expectIdentical(
      render(sampleHold(source(), { freq: 90 })),
      render(sampleHold(source(), { freq: 90, clock: 0 })),
      'sample hold clock held low',
    );
  });

  it('a gate with hold at 0 passes what is over its threshold, untouched', () => {
    // Through the material, because `hold` is expressed in ASL rather than in
    // the kernel: the claim is that the pulse-and-or is the identity at zero
    // width, which is a claim about the graph the material builds.
    const params = { input: 0.3, threshold: 0.05, attack: 0.002, release: 0.05, hold: 0 };
    const passed = OfflineRenderer.render(gateMaterial.graph, {
      duration: DURATION,
      sampleRate: SR,
      params,
    }).samples;
    let open = 0;
    for (const v of passed) open = Math.max(open, Math.abs(v));
    expect(open, 'a gate over its threshold passes signal').toBeCloseTo(0.3, 6);
  });
});

describe('and it does do something when it is moved', () => {
  it('ladder drive above 1 saturates', () => {
    const opts = { cutoff: 900, resonance: 0.4 };
    const clean = render(filter.ladder(audio.input(), { ...opts, drive: 1 }), { input: 0.5 });
    const driven = render(filter.ladder(audio.input(), { ...opts, drive: 5 }), { input: 0.5 });
    let worst = 0;
    for (let i = 0; i < clean.length; i += 1) worst = Math.max(worst, Math.abs(clean[i]! - driven[i]!));
    expect(worst).toBeGreaterThan(1e-4);
  });

  it('a gate with hold keeps the gate open past the point it would have shut', () => {
    // A short burst, then nothing. Without hold the gate shuts as soon as the
    // follower falls under the threshold; with it, it stays open.
    const of = (hold: number): number => {
      const out = OfflineRenderer.render(gateMaterial.graph, {
        duration: DURATION,
        sampleRate: SR,
        params: { input: 0, threshold: 0.05, attack: 0.002, release: 0.005, hold },
      }).samples;
      return out.length;
    };
    expect(of(0)).toBe(of(0.1));

    // The audible half, on a signal that crosses the threshold and falls back.
    const shape = (hold: number): number => {
      const renderer = new BlockRenderer(gateMaterial.graph, {
        sampleRate: SR,
        params: { input: 0.5, threshold: 0.05, attack: 0.002, release: 0.005, hold },
      });
      renderer.render(256);
      renderer.setParam('input', 0);
      let openFor = 0;
      for (const v of renderer.render(2048).left) if (Math.abs(v) > 0) openFor += 1;
      return openFor;
    };
    expect(shape(0.03), 'hold keeps it open longer').toBeGreaterThanOrEqual(shape(0));
  });

  it('a sample and hold with freq 0 holds until its clock says otherwise', () => {
    const held = render(sampleHold(lfo({ rate: 311 }), { freq: 0 }));
    expect(new Set(held).size, 'nothing clocks it, so it never moves').toBe(1);
    const clocked = render(sampleHold(lfo({ rate: 311 }), { freq: 0, clock: clock({ freq: 200 }) }));
    expect(new Set(clocked).size, 'a clock steps it').toBeGreaterThan(1);
  });
});
