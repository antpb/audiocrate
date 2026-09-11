/**
 * Plugin delay compensation. One shared origin, then relative shifts per
 * track. The 10 ms schedule-ahead is so start() stays in the future after
 * the graph is built. It is not a musical offset.
 *
 * delaySec = (maxLatency - trackLatency) / sampleRate
 *
 * The wettest track starts immediately. Drier tracks wait so every chain
 * emerges at the master at the same instant.
 *
 * Callers must capture one schedule origin AFTER the graph is built and
 * pass that same origin to every clip and MIDI event. Measuring
 * AudioContext.currentTime per track (after each await) is how layers
 * pick up different start points.
 */
import { audioMaterialRegistry, type AudioMaterialRegistry } from '../registry/AudioMaterialRegistry';
import type { AudioMaterial } from '../graph/AudioMaterial';

/** Schedule-ahead window. Keeps start() in the future. */
export const PDC_SCHEDULE_AHEAD_SEC = 0.01;

export function pdcStartDelaySec(
  trackLatencySamples: number,
  maxLatencySamples: number,
  sampleRate: number,
): number {
  if (!(sampleRate > 0)) return 0;
  const maxSec = Math.max(0, maxLatencySamples) / sampleRate;
  const trackSec = Math.max(0, trackLatencySamples) / sampleRate;
  return Math.max(0, maxSec - trackSec);
}

/** When the first mix sample is audible, relative to context "now". */
export function pdcAudibleOriginSec(
  maxTrackLatencySamples: number,
  masterLatencySamples: number,
  sampleRate: number,
): number {
  if (!(sampleRate > 0)) return 0;
  return (Math.max(0, maxTrackLatencySamples) + Math.max(0, masterLatencySamples)) / sampleRate;
}

/**
 * Total latency an AudioMaterial chain contributes, by asking each AudioMaterial's own
 * plugin. A plugin that reports none (or is not registered) contributes 0,
 * which is the right answer for a pure ASL AudioMaterial: the interpreter is
 * sample-for-sample.
 *
 * Crate used to hardcode the amp's 512-sample convolver here. It cannot, and
 * should not, know that number.
 */
export function chainLatencySamples(
  materials: Iterable<AudioMaterial>,
  registry: AudioMaterialRegistry = audioMaterialRegistry,
): number {
  let total = 0;
  for (const material of materials) {
    total += registry.forMaterial(material)?.latencySamples?.(material) ?? 0;
  }
  return total;
}
