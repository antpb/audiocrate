import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { delay, rectify, uniform } from '../asl/builders';
import {
  COMMON_DIVISION_BEATS,
  COMMON_DIVISION_NAMES,
  transport,
} from '../asl/transportNodes';

/**
 * Materials that follow the host's musical position.
 *
 * These exist as much to demonstrate the shape as to be used: a division
 * `enum` parameter, a `transport.division` lookup that turns its index into
 * beats, and a `transport` node that turns beats into whatever the Material
 * needs. Every tempo-synced effect anyone writes will be that same three-step
 * chain, and the menu and the lookup table come from one place so they cannot
 * disagree.
 */

/** The division menu every Material here shares. */
const divisionParam = (defaultName: (typeof COMMON_DIVISION_NAMES)[number]) =>
  param.enum(COMMON_DIVISION_NAMES, { default: defaultName, label: 'Division' });

/**
 * A delay whose time is a note length rather than a number of seconds, so it
 * stays in time through a tempo change instead of needing to be reset.
 */
export const syncedDelayMaterial = new Material({
  name: 'SyncedDelay',
  kind: 'synceddelay',
  params: {
    division: divisionParam('1/8'),
    feedback: param.range(0, 0.95, { default: 0.4 }),
    mix: param.range(0, 1, { default: 0.35 }),
  },
  automatable: ['division', 'feedback', 'mix'],
  graph: ({ input, params }) =>
    delay(input, {
      timeSec: transport.seconds(
        transport.division(params.division, { divisions: COMMON_DIVISION_BEATS }),
      ),
      feedback: params.feedback,
      mix: params.mix,
      // A whole note at 40 bpm is six seconds, and a delay line that is too
      // short does not sound wrong, it silently gives you a different note
      // length than the menu says.
      maxTimeSec: 8,
    }),
});

/**
 * A 0..1 ramp locked to the grid, as a control signal. Feed it into anything
 * that takes a value: a filter cutoff, a gain, a pan.
 *
 * `channels: 1` because the output is a control voltage, and a second
 * evaluation pass could not produce a different answer.
 */
export const syncedRampMaterial = new Material({
  name: 'SyncedRamp',
  kind: 'syncedramp',
  channels: 1,
  params: {
    division: divisionParam('1/4'),
    depth: param.range(0, 1, { default: 1 }),
  },
  automatable: ['division', 'depth'],
  cvPolarity: 'unipolar',
  graph: ({ params }) =>
    transport
      .phase(transport.division(params.division, { divisions: COMMON_DIVISION_BEATS }))
      .mul(params.depth),
});

/**
 * A one-sample pulse at every division boundary: the clock input the
 * sequencer, euclidean and clock-divider Materials already take, except
 * locked to the song rather than free-running.
 */
export const syncedClockMaterial = new Material({
  name: 'SyncedClock',
  kind: 'syncedclock',
  channels: 1,
  params: {
    division: divisionParam('1/4'),
  },
  automatable: ['division'],
  cvPolarity: 'unipolar',
  graph: ({ params }) =>
    transport.pulse(transport.division(params.division, { divisions: COMMON_DIVISION_BEATS })),
});

/**
 * A tremolo that lines up with the beat. One expression: a grid-locked ramp
 * folded into a triangle, scaled by depth, applied to the input.
 */
export const syncedTremoloMaterial = new Material({
  name: 'SyncedTremolo',
  kind: 'syncedtremolo',
  params: {
    division: divisionParam('1/8'),
    depth: param.range(0, 1, { default: 0.6 }),
  },
  automatable: ['division', 'depth'],
  graph: ({ input, params }) => {
    const phase = transport.phase(
      transport.division(params.division, { divisions: COMMON_DIVISION_BEATS }),
    );
    // Triangle from a ramp: 1 - |2p - 1|. Rises and falls within the
    // division rather than jumping back at the boundary, which a raw ramp
    // would do audibly.
    const triangle = uniform(1).add(rectify(phase.mul(2).add(-1), { mode: 'full' }).mul(-1));
    const depth = params.depth;
    // Unity at depth 0, full modulation at depth 1.
    return input.mul(uniform(1).add(depth.mul(-1)).add(triangle.mul(depth)));
  },
});

export const syncedMaterials = [
  syncedDelayMaterial,
  syncedRampMaterial,
  syncedClockMaterial,
  syncedTremoloMaterial,
] as const;
