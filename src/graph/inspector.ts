import type { AudioMaterial } from './AudioMaterial';
import { formatParam, normalizeParam, type ParamCurve, type ParamDescriptor } from './param';

/**
 * Crate is not a UI library. This is the model a control panel is built
 * from, not the panel. An AudioMaterial already carries everything needed; this
 * turns it into the shape a host wants, once, so a React inspector, a
 * canvas inspector, and a plugin parameter tree are three views of one
 * description rather than three readings of `material.params`.
 *
 * The model is plain data. It does not hold the AudioMaterial, and it does not
 * update: take a fresh one when values change, or read `material.getParam`
 * directly and use the model only for layout. A model that subscribed would
 * be a state library.
 */

/** What kind of control this parameter wants. A host may still ignore it. */
export type ControlKind = 'fader' | 'stepper' | 'menu' | 'switch';

export interface InspectorControl {
  /** The key on `material.params`, and what `setParam` takes. */
  readonly name: string;
  /** `descriptor.label`, else a title derived from `name`. */
  readonly label: string;
  readonly kind: ControlKind;
  readonly descriptor: ParamDescriptor;
  readonly value: number;
  /** `value` as 0..1, which is what a generic fader binds to. */
  readonly normalized: number;
  /** What to print beside the control. */
  readonly display: string;
  readonly unit?: string;
  /** Menu labels in value order. Present for `menu` and `switch`. */
  readonly options?: readonly string[];
  /** Legal increment, when there is one. */
  readonly step?: number;
  /**
   * How `normalized` maps onto `value`. A host drawing its own fader must use
   * `normalizeParam` / `denormalizeParam` rather than interpolating between
   * `min` and `max`, or a log-tapered control will not match its own readout.
   */
  readonly curve?: ParamCurve;
  readonly min: number;
  readonly max: number;
  /** Whether an automation lane may write this. */
  readonly automatable: boolean;
  /** Plugin parameter address, when this maps to one. */
  readonly address?: number;
}

export interface InspectorModel {
  readonly name: string;
  readonly kind: string;
  readonly controls: readonly InspectorControl[];
  /** True for an insert. False for a source, which is the instrument slot. */
  readonly readsAudio: boolean;
  /** Live inputs beyond the main one: a host has to route these. */
  readonly auxInputs: readonly string[];
  readonly polyphony: number;
  /** Asset keys the AudioMaterial is currently holding. */
  readonly assets: readonly string[];
}

export function describeAudioMaterial(material: AudioMaterial): InspectorModel {
  const automatable = new Set(material.automatable);
  const controls = Object.entries(material.params).map(([name, descriptor]) =>
    describeControl(name, descriptor, material.getParam(name), automatable.has(name)),
  );
  return {
    name: material.name,
    kind: material.kind,
    controls,
    readsAudio: material.audioInputs.length > 0,
    auxInputs: material.auxAudioInputs,
    polyphony: material.polyphony,
    assets: material.assetKeys,
  };
}

export function describeControl(
  name: string,
  descriptor: ParamDescriptor,
  value: number,
  automatable: boolean,
): InspectorControl {
  return {
    name,
    label: descriptor.label ?? humanizeParamName(name),
    kind: controlKindFor(descriptor),
    descriptor,
    value,
    normalized: normalizeParam(descriptor, value),
    display: formatParam(descriptor, value),
    min: descriptor.min,
    max: descriptor.max,
    automatable,
    ...(descriptor.unit !== undefined ? { unit: descriptor.unit } : {}),
    ...(descriptor.step !== undefined ? { step: descriptor.step } : {}),
    ...(descriptor.curve !== undefined ? { curve: descriptor.curve } : {}),
    ...(descriptor.address !== undefined ? { address: descriptor.address } : {}),
    ...(descriptor.kind === 'enum' ? { options: descriptor.options } : {}),
    ...(descriptor.kind === 'toggle' ? { options: descriptor.labels } : {}),
  };
}

function controlKindFor(descriptor: ParamDescriptor): ControlKind {
  switch (descriptor.kind) {
    case 'toggle':
      return 'switch';
    case 'enum':
      return 'menu';
    case 'stepped':
      return 'stepper';
    case 'range':
      return 'fader';
  }
}

/**
 * `cutoff` to "Cutoff", `gainDb` to "Gain Db". The second one is wrong, which
 * is exactly why `label` exists: this is a decent fallback, not a correct
 * answer, and an AudioMaterial that cares should say what it means.
 */
export function humanizeParamName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (spaced.length === 0) return name;
  return spaced
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
