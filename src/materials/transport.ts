import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { transport } from '../asl/transportNodes';

/**
 * Host musical position.
 *
 * Clock is a free-running pulse in Hz. Synced Clock reads the host snapshot
 * and fires on a division. Neither one is where a patcher sets tempo.
 *
 * This Material is the publisher: its params are what a host without a DAW
 * session (the crate editor) writes onto `setTransport`. Synced Delay,
 * Synced Clock, Looper, and every other `transport.*` reader keep using the
 * snapshot. Homecrate already has a session clock, so it does not need this
 * node on every track. The patcher does, because it starts from scratch.
 *
 * The graph output is a quarter-note pulse, the same signal Synced Clock
 * produces at 1/4. Named outlets on the editor node (`bpm`, `bars`,
 * `playing`, ...) are the other `transport.*` fields, not extra graph
 * evaluations.
 */
export const TRANSPORT_KIND = 'transport';

export const TRANSPORT_OUTPUTS = [
  'bpm',
  'beats',
  'bars',
  'playing',
  'beatsPerBar',
  'beatUnit',
  'pulse',
] as const;

export type TransportOutput = (typeof TRANSPORT_OUTPUTS)[number];

export const TRANSPORT_ABSOLUTE_OUTPUTS = [
  'bpm',
  'beats',
  'bars',
  'playing',
  'beatsPerBar',
  'beatUnit',
] as const;

export type TransportAbsoluteOutput = (typeof TRANSPORT_ABSOLUTE_OUTPUTS)[number];

export const TIME_SIG_PRESETS = [
  { label: '4/4', beatsPerBar: 4, beatUnit: 4 },
  { label: '3/4', beatsPerBar: 3, beatUnit: 4 },
  { label: '2/4', beatsPerBar: 2, beatUnit: 4 },
  { label: '6/8', beatsPerBar: 6, beatUnit: 8 },
  { label: '12/8', beatsPerBar: 12, beatUnit: 8 },
  { label: '5/4', beatsPerBar: 5, beatUnit: 4 },
  { label: '7/8', beatsPerBar: 7, beatUnit: 8 },
  { label: '2/2', beatsPerBar: 2, beatUnit: 2 },
] as const;

export function isTransportKind(kind: string): boolean {
  return kind === TRANSPORT_KIND;
}

export function isTransportOutput(name: string): name is TransportOutput {
  return (TRANSPORT_OUTPUTS as readonly string[]).includes(name);
}

export function isTransportAbsoluteOutput(name: string): name is TransportAbsoluteOutput {
  return (TRANSPORT_ABSOLUTE_OUTPUTS as readonly string[]).includes(name);
}

export interface MaterialTransport {
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
  startSec?: number;
}

export function resolvedTransport(input: Partial<MaterialTransport> | null | undefined): MaterialTransport {
  return {
    bpm: input?.bpm && input.bpm > 0 ? input.bpm : 120,
    beatsPerBar: input?.beatsPerBar && input.beatsPerBar > 0 ? input.beatsPerBar : 4,
    beatUnit: input?.beatUnit && input.beatUnit > 0 ? input.beatUnit : 4,
    ...(input?.startSec != null && input.startSec > 0 ? { startSec: input.startSec } : {}),
  };
}

export function transportFromMaterial(material: Material, startSec?: number): MaterialTransport {
  return resolvedTransport({
    bpm: material.getParam('bpm'),
    beatsPerBar: material.getParam('beatsPerBar'),
    beatUnit: material.getParam('beatUnit'),
    startSec,
  });
}

export function applyTransportToMaterial(material: Material, input: Partial<MaterialTransport>): void {
  const next = resolvedTransport({
    bpm: input.bpm ?? material.getParam('bpm'),
    beatsPerBar: input.beatsPerBar ?? material.getParam('beatsPerBar'),
    beatUnit: input.beatUnit ?? material.getParam('beatUnit'),
  });
  material.setParam('bpm', next.bpm);
  material.setParam('beatsPerBar', next.beatsPerBar);
  material.setParam('beatUnit', next.beatUnit);
}

export const transportMaterial = new Material({
  name: 'Transport',
  kind: TRANSPORT_KIND,
  channels: 1,
  params: {
    bpm: param.range(20, 300, { default: 120, unit: 'bpm', label: 'BPM' }),
    beatsPerBar: param.stepped(1, 16, { step: 1, default: 4, label: 'Beats' }),
    beatUnit: param.stepped(1, 16, { step: 1, default: 4, label: 'Unit' }),
  },
  automatable: ['bpm', 'beatsPerBar', 'beatUnit'],
  cvPolarity: 'unipolar',
  graph: () => transport.pulse(),
});
