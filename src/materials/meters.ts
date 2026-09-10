/**
 * Inserts that measure without changing anything.
 *
 * Each one is a passthrough carrying a tap (`asl/analysis.ts`), so dropping
 * one into a chain is not a decision about the sound. That is the whole
 * design: a meter you have to think about is a meter people leave out.
 *
 * They report nothing until a host asks (`VoiceHandle.setAnalysisInterval`),
 * and the analysis itself happens on the main thread from the captured
 * window. The audio thread copies samples into a ring buffer and that is all
 * it ever does, because a spectrum display asking for 30 frames a second
 * must not be able to make the audio glitch.
 *
 * Note the existing `rms` / `peak` / `onset` Materials are a different thing:
 * they *output* their measurement as a signal, for a graph to use as control
 * voltage. These pass the signal through and report out of band, for a UI.
 * The editor also publishes those readings as named CV outlets (`note`,
 * `hz`, `gate`, ...) so a patch can follow live playing. Flatten turns
 * those cables into `pitch` / `peak` / `rms` followers.
 */
import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { tap, DEFAULT_CAPTURE_WINDOW } from '../asl/analysis';

/** The tap id each Material reports under, so a reader knows what to look for. */
export const METER_TAP = 'meter';
export const SCOPE_TAP = 'scope';

export function createMeterMaterial(): Material {
  return new Material({
    name: 'Meter',
    kind: 'meter',
    params: {},
    // Mono on purpose: a meter reading a different channel depending on
    // whether the graph happens to be stereo would be worse than one that
    // consistently reads the left. Tap `audio.left().add(audio.right())` for
    // a summed reading.
    channels: 1,
    graph: ({ input }) => tap.meter(input, { id: METER_TAP }),
  });
}

/**
 * Captures a window for the main thread to analyse. One Material serves an
 * oscilloscope, a spectrum analyser, a tuner and a loudness meter, because
 * all four want the same thing from the audio thread and differ only in what
 * is done with it afterwards.
 */
export function createScopeMaterial(windowSize: number = DEFAULT_CAPTURE_WINDOW): Material {
  return new Material({
    name: 'Scope',
    kind: 'scope',
    params: {},
    channels: 1,
    graph: ({ input }) => tap.capture(input, { id: SCOPE_TAP, windowSize }),
  });
}

/** Level and window together, for a UI that wants both from one insert. */
export function createAnalyzerMaterial(windowSize: number = DEFAULT_CAPTURE_WINDOW): Material {
  return new Material({
    name: 'Analyzer',
    kind: 'analyzer',
    params: {},
    channels: 1,
    graph: ({ input }) => tap.capture(tap.meter(input, { id: METER_TAP }), { id: SCOPE_TAP, windowSize }),
  });
}

/** Same capture as Analyzer, inspector-first for pitch. */
export function createTunerMaterial(windowSize: number = DEFAULT_CAPTURE_WINDOW): Material {
  return new Material({
    name: 'Tuner',
    kind: 'tuner',
    params: {},
    channels: 1,
    graph: ({ input }) => tap.capture(tap.meter(input, { id: METER_TAP }), { id: SCOPE_TAP, windowSize }),
  });
}

export const meterMaterial = createMeterMaterial();
export const scopeMaterial = createScopeMaterial();
export const analyzerMaterial = createAnalyzerMaterial();
export const tunerMaterial = createTunerMaterial();

export const METER_OUTPUTS = ['audio', 'peak', 'rms'] as const;
export const SCOPE_OUTPUTS = ['audio', 'peak', 'rms'] as const;
export const TUNER_OUTPUTS = ['audio', 'note', 'cv', 'hz', 'cents', 'gate'] as const;
export const ANALYZER_OUTPUTS = ['audio', 'note', 'cv', 'hz', 'cents', 'gate', 'peak', 'rms', 'lufs'] as const;

export type AnalysisKind = 'meter' | 'scope' | 'analyzer' | 'tuner';

export function isAnalysisKind(kind: string): kind is AnalysisKind {
  return kind === 'meter' || kind === 'scope' || kind === 'analyzer' || kind === 'tuner';
}

export function analysisOutputs(kind: string): readonly string[] {
  switch (kind) {
    case 'meter':
      return METER_OUTPUTS;
    case 'scope':
      return SCOPE_OUTPUTS;
    case 'tuner':
      return TUNER_OUTPUTS;
    case 'analyzer':
      return ANALYZER_OUTPUTS;
    default:
      return ['audio'];
  }
}

export function isAnalysisAbsoluteOutput(name: string): boolean {
  return name !== 'audio' && name !== 'cv';
}
