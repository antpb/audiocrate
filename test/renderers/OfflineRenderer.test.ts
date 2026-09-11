import { describe, expect, it } from 'vitest';
import { ASL } from '../../src/asl/graph';
import { uniform } from '../../src/asl/builders';
import { AutomationLane } from '../../src/automation/AutomationLane';
import { Easing } from '../../src/automation/Easing';
import { Time } from '../../src/Time';
import { OfflineRenderer } from '../../src/renderers/OfflineRenderer';
import { synthVoiceMaterial } from '../../src/materials/synthVoice';
import { parametricEqMaterial } from '../../src/materials/parametricEq';

describe('OfflineRenderer', () => {
  it('renders exactly duration * sampleRate samples, no AudioContext involved', () => {
    const graph = ASL.node(() => uniform(0));
    const { samples, sampleRate } = OfflineRenderer.render(graph, { duration: 0.01, sampleRate: 48000 });
    expect(sampleRate).toBe(48000);
    expect(samples.length).toBe(480);
    expect(samples.every((s) => s === 0)).toBe(true);
  });

  it('defaults to 48000Hz when sampleRate is omitted', () => {
    const graph = ASL.node(() => uniform(1));
    const { samples, sampleRate } = OfflineRenderer.render(graph, { duration: 0.001 });
    expect(sampleRate).toBe(48000);
    expect(samples.length).toBe(48);
  });

  it('rounds a fractional duration*sampleRate to the nearest sample count', () => {
    const graph = ASL.node(() => uniform(1));
    const { samples } = OfflineRenderer.render(graph, { duration: 0.0001, sampleRate: 48000 }); // 4.8 samples
    expect(samples.length).toBe(5);
  });

  it('merges params into noteOn at sample 0', () => {
    const graph = ASL.node(({ note }) => uniform(note).toFrequency());
    const { samples } = OfflineRenderer.render(graph, { duration: 0.0001, sampleRate: 48000, params: { note: 69 } });
    expect(samples[0]).toBeCloseTo(440, 5);
  });

  it('renders synthVoiceMaterial across a full note-on/note-off cycle, matching direct compileVoice use', () => {
    const { samples, sampleRate } = OfflineRenderer.render(synthVoiceMaterial.graph, {
      duration: 0.7,
      sampleRate: 48000,
      params: { note: 69, velocity: 0.9, ...synthVoiceMaterial.snapshotParams() },
      noteOffAt: 0.3,
    });

    for (const sample of samples) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThanOrEqual(1.1);
    }
    // well past a 0.35s release starting at 0.3s into a 0.7s render: fully silent
    expect(samples[samples.length - 1]).toBeCloseTo(0, 1);
  });

  it('holds the note for the whole render when noteOffAt is omitted (no release dip)', () => {
    const { samples } = OfflineRenderer.render(synthVoiceMaterial.graph, {
      duration: 0.3,
      params: { note: 69, velocity: 0.9, ...synthVoiceMaterial.snapshotParams() },
    });
    // still in attack/decay/sustain the whole time: never returns to silence
    expect(Math.abs(samples[samples.length - 1]!)).toBeGreaterThan(0.01);
  });

  it('feeds inputSignal into an effect AudioMaterial param-by-param, matching a manual compileVoice loop', () => {
    const inputSignal = Float32Array.from({ length: 200 }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / 48000));
    const { samples } = OfflineRenderer.render(parametricEqMaterial.graph, {
      duration: 200 / 48000,
      sampleRate: 48000,
      params: parametricEqMaterial.snapshotParams(), // gainDb defaults to 0: exact bypass
    });
    // no inputSignal supplied: state.params.input stays at its default (0)
    expect(samples.every((s) => s === 0)).toBe(true);

    const { samples: passthrough } = OfflineRenderer.render(parametricEqMaterial.graph, {
      duration: 200 / 48000,
      sampleRate: 48000,
      params: parametricEqMaterial.snapshotParams(),
      inputSignal,
    });
    for (let i = 0; i < inputSignal.length; i++) {
      expect(passthrough[i]).toBeCloseTo(inputSignal[i]!, 10);
    }
  });

  it('writes automation into params at the start of each block', () => {
    const graph = ASL.node(({ cutoff }) => cutoff);
    const lane = new AutomationLane({
      shape: Easing.linear,
      from: 200,
      to: 800,
      range: { start: Time.seconds(0), end: Time.seconds(1) },
    });
    const { samples } = OfflineRenderer.render(graph, {
      duration: 1,
      sampleRate: 100,
      params: { cutoff: 200 },
      automation: [{ target: 'cutoff', lane }],
    });
    expect(samples[0]).toBeCloseTo(200);
    expect(samples[50]).toBeCloseTo(500);
    expect(samples[99]).toBeCloseTo(794);
  });
});
