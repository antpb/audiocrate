/**
 * The two spatial nodes, as Materials.
 *
 * ## Why these have graphs that ignore most of their params
 *
 * `spatialsource` really runs as `crate-foa-encoder`, an AudioWorkletNode with
 * four output channels, and `spatialmaster` really runs as `SpatialBus`, a
 * graph of native gains and panners. Neither is expressible in ASL: ASL voices
 * are mono or stereo, and B-format is four channels that must not be mixed
 * down on the way past.
 *
 * They are Materials anyway, for the same reason `gain` and `stereopan` are
 * Materials whose live implementation is a native node: a Material is what
 * carries parameter descriptors, ranges, automation targets, inspector labels
 * and patch serialization. Without one, a spatial node would be a `tool` like
 * `master`, and a tool cannot be edited, automated or saved with its values.
 *
 * So the ASL graph here is the honest reduction: what this node is when
 * nothing spatial is listening. A source is its input at its gain; a master is
 * its input at its level. An offline render that ignores the spatial path gets
 * the signal rather than silence, and the position lives where it can actually
 * be applied at audio rate.
 */
import { Material } from '../graph/Material';
import { param } from '../graph/param';

/**
 * A point source. Its output carries direction, not sound you can listen to:
 * connect it to a `spatialmaster`, not to the mixer.
 *
 * Position is cartesian in metres, matching the frame in `positions.ts`:
 * +x right, +y up, -z front. Cartesian rather than azimuth because these are
 * the values an LFO is patched into, and "an LFO on x" should mean what it
 * looks like. Azimuth and distance remain the interchange encoding, converted
 * at the export boundary by `cartesianToSpherical`.
 */
export const spatialSourceMaterial = new Material({
  name: 'Spatial Source',
  kind: 'spatialsource',
  params: {
    // The range is generous because distance attenuation, not the range,
    // is what makes a far source quiet. Clamping position at the edge of the
    // room would make an orbit flatten into a square.
    x: param.range(-32, 32, { default: 0, unit: 'm' }),
    y: param.range(-32, 32, { default: 0, unit: 'm' }),
    z: param.range(-32, 32, { default: -1, unit: 'm' }),
    gain: param.range(0, 4, { default: 1 }),
    global: param.toggle({ default: false, label: 'Global' }),
    distanceModel: param.enum(['Preview', 'Web HRTF'], {
      default: 'Preview',
      label: 'Distance',
    }),
  },
  automatable: ['x', 'y', 'z', 'gain'],
  channels: 1,
  graph: ({ input, params }) => input.mul(params.gain),
});

/**
 * Sums any number of spatial sources, turns the field to face the listener,
 * and decodes it to stereo.
 *
 * `yaw` and `pitch` are the listener's head, not the field's: yaw 0 looks
 * down -z and positive yaw turns right, matching `SpatialListener`.
 */
export const spatialMasterMaterial = new Material({
  name: 'Spatial Master',
  kind: 'spatialmaster',
  params: {
    yaw: param.range(-180, 180, { default: 0, unit: 'deg' }),
    pitch: param.range(-90, 90, { default: 0, unit: 'deg' }),
    decode: param.enum(['Binaural', 'Stereo', 'Ambisonic'], {
      default: 'Binaural',
      label: 'Decode',
    }),
    level: param.range(0, 2, { default: 1 }),
  },
  automatable: ['yaw', 'pitch', 'level'],
  channels: 2,
  graph: ({ input, params }) => input.mul(params.level),
});

/** Kinds whose live implementation is spatial rather than ASL. */
export const SPATIAL_SOURCE_KIND = spatialSourceMaterial.kind;
export const SPATIAL_MASTER_KIND = spatialMasterMaterial.kind;

/** Decode names in `spatialmaster`'s `decode` enum order. */
export const SPATIAL_DECODE_MODES = ['binaural', 'stereo', 'ambisonic'] as const;
