/**
 * `param.range(-18, 18, { default: 0, unit: 'dB' })`.
 * Declared data, not a value itself, so an AudioMaterial's inspector model
 * can be generated from it rather than hand-built.
 *
 * **Every parameter is one number.** An enumeration is an index, a toggle is
 * 0 or 1, a stepped control is a quantized range. That is not a shortcut: a
 * param crosses to the audio thread, gets written by an automation lane, gets
 * quantized onto a collab wire, and maps onto a plugin parameter tree, and
 * every one of those speaks numbers. A parameter kind adds meaning,
 * validation and presentation on top of a number; it never introduces a
 * second value type.
 *
 * So every descriptor carries `min`, `max` and `default` whatever its kind,
 * and code that only wants a fader can read those three and ignore the rest.
 */

export interface ParamDescriptorBase {
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly unit?: string;
  /**
   * Display name. Absent means a host derives one from the param key, which
   * is right often enough to be the default and wrong often enough
   * (`gainDb`, `q`, `hpf`) to be worth overriding.
   */
  readonly label?: string;
  /** AU / VST3 parameter address, when this descriptor maps a plugin param. */
  readonly address?: number;
  /**
   * Legal values are `min + k * step`. Absent means continuous. A write off
   * the grid snaps rather than throwing: an automation lane interpolates, and
   * a fader drag produces whatever the pointer landed on, so the descriptor
   * snaps rather than requiring every caller to quantize first.
   */
  readonly step?: number;
  /**
   * How the value maps onto a control's travel. Affects `normalizeParam` and
   * `denormalizeParam` only: the stored value, what automation writes, and
   * what the graph reads are always real units on a linear scale.
   *
   * A 20 Hz to 20 kHz fader declared linear puts the bottom two octaves in
   * the first one percent of its travel.
   */
  readonly curve?: ParamCurve;
}

/**
 * `linear` is the default. `log` is geometric, right for anything measured in
 * octaves or decades, and requires a positive minimum. `exp` is a squared
 * curve that gives the low end more travel and, unlike `log`, works when the
 * minimum is zero, which is why a time or a depth control uses it.
 */
export type ParamCurve = 'linear' | 'log' | 'exp';

export interface RangeParamOptions {
  default: number;
  unit?: string;
  address?: number;
  label?: string;
  curve?: ParamCurve;
}

export interface RangeParamDescriptor extends ParamDescriptorBase {
  readonly kind: 'range';
}

export interface SteppedParamOptions extends RangeParamOptions {
  /** Distance between legal values. Must be positive and divide the span. */
  step: number;
}

export interface SteppedParamDescriptor extends ParamDescriptorBase {
  readonly kind: 'stepped';
  readonly step: number;
}

export interface EnumParamOptions<T extends string> {
  /** One of `options`. Named, not indexed, because an index in source is unreadable. */
  default: T;
  address?: number;
  label?: string;
}

export interface EnumParamDescriptor<T extends string = string> extends ParamDescriptorBase {
  readonly kind: 'enum';
  /** Display order is value order: index 0 is `options[0]`. */
  readonly options: readonly T[];
  readonly step: 1;
}

export interface ToggleParamOptions {
  default: boolean;
  address?: number;
  label?: string;
  /** Labels for off and on, when "Off"/"On" is not what this control means. */
  labels?: readonly [string, string];
}

export interface ToggleParamDescriptor extends ParamDescriptorBase {
  readonly kind: 'toggle';
  readonly labels: readonly [string, string];
  readonly min: 0;
  readonly max: 1;
  readonly step: 1;
}

export type ParamDescriptor =
  | RangeParamDescriptor
  | SteppedParamDescriptor
  | EnumParamDescriptor
  | ToggleParamDescriptor;

export function paramNameForAddress(
  params: Record<string, ParamDescriptor>,
  address: number,
): string | null {
  for (const [name, desc] of Object.entries(params)) {
    if (desc.address === address) return name;
  }
  return null;
}

export const param = {
  range(min: number, max: number, options: RangeParamOptions): RangeParamDescriptor {
    if (!(min < max)) {
      throw new RangeError(`param.range: min (${min}) must be less than max (${max})`);
    }
    if (options.default < min || options.default > max) {
      throw new RangeError(`param.range: default (${options.default}) must be within [${min}, ${max}]`);
    }
    assertCurve('param.range', min, options.curve);
    return {
      kind: 'range',
      min,
      max,
      default: options.default,
      ...(options.unit !== undefined ? { unit: options.unit } : {}),
      ...(options.address !== undefined ? { address: options.address } : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.curve !== undefined && options.curve !== 'linear' ? { curve: options.curve } : {}),
    };
  },

  /**
   * A range whose legal values are on a grid: filter poles, a division count,
   * a whole number of semitones.
   */
  stepped(min: number, max: number, options: SteppedParamOptions): SteppedParamDescriptor {
    if (!(min < max)) {
      throw new RangeError(`param.stepped: min (${min}) must be less than max (${max})`);
    }
    if (!(options.step > 0)) {
      throw new RangeError(`param.stepped: step (${options.step}) must be positive`);
    }
    // A grid that does not land on `max` means the top of the control is
    // unreachable, which looks like a broken fader and reads as a typo.
    const spans = (max - min) / options.step;
    if (Math.abs(spans - Math.round(spans)) > 1e-9) {
      throw new RangeError(
        `param.stepped: step (${options.step}) does not divide the span [${min}, ${max}]`,
      );
    }
    if (options.default < min || options.default > max) {
      throw new RangeError(`param.stepped: default (${options.default}) must be within [${min}, ${max}]`);
    }
    const steps = (options.default - min) / options.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      throw new RangeError(
        `param.stepped: default (${options.default}) is not on the step grid from ${min}`,
      );
    }
    assertCurve('param.stepped', min, options.curve);
    return {
      kind: 'stepped',
      min,
      max,
      step: options.step,
      default: options.default,
      ...(options.unit !== undefined ? { unit: options.unit } : {}),
      ...(options.address !== undefined ? { address: options.address } : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.curve !== undefined && options.curve !== 'linear' ? { curve: options.curve } : {}),
    };
  },

  /**
   * A choice from a fixed list. The value is the index, so it automates,
   * serializes and maps onto a plugin parameter tree like anything else, but
   * the descriptor carries the labels so nobody has to keep a parallel table.
   */
  enum<const T extends string>(
    options: readonly T[],
    // `NoInfer` so the option list alone decides the type. Without it a
    // typo'd default widens T to include the typo and compiles clean, which
    // is the exact mistake this kind exists to catch.
    config: EnumParamOptions<NoInfer<T>>,
  ): EnumParamDescriptor<T> {
    if (options.length < 2) {
      throw new RangeError(`param.enum: needs at least two options, got ${options.length}`);
    }
    if (new Set(options).size !== options.length) {
      throw new RangeError(`param.enum: options must be unique (${options.join(', ')})`);
    }
    const index = options.indexOf(config.default);
    if (index === -1) {
      throw new RangeError(`param.enum: default "${config.default}" is not one of ${options.join(', ')}`);
    }
    return {
      kind: 'enum',
      options: [...options],
      min: 0,
      max: options.length - 1,
      step: 1,
      default: index,
      ...(config.address !== undefined ? { address: config.address } : {}),
      ...(config.label !== undefined ? { label: config.label } : {}),
    };
  },

  /** On or off. Two-option `enum`'s common case, spelled the way it reads. */
  toggle(config: ToggleParamOptions): ToggleParamDescriptor {
    return {
      kind: 'toggle',
      min: 0,
      max: 1,
      step: 1,
      default: config.default ? 1 : 0,
      labels: config.labels ?? ['Off', 'On'],
      ...(config.address !== undefined ? { address: config.address } : {}),
      ...(config.label !== undefined ? { label: config.label } : {}),
    };
  },
};

/**
 * A log taper cannot reach zero, and pretending otherwise gives an infinity
 * somewhere further downstream instead of an error here.
 */
function assertCurve(fn: string, min: number, curve: ParamCurve | undefined): void {
  if (curve === 'log' && min <= 0) {
    throw new RangeError(
      `${fn}: a 'log' curve needs a positive minimum (got ${min}). Use 'exp' for a range that includes zero.`,
    );
  }
}

/** Snaps onto the descriptor's grid. Continuous params are returned unchanged. */
export function quantizeParam(descriptor: ParamDescriptor, value: number): number {
  if (descriptor.step === undefined) return value;
  const snapped = descriptor.min + Math.round((value - descriptor.min) / descriptor.step) * descriptor.step;
  // Re-derive from the grid rather than trusting float accumulation, so a
  // stepped param's stored value compares equal to the same value declared.
  return Math.min(descriptor.max, Math.max(descriptor.min, roundToGrid(snapped, descriptor.step)));
}

function roundToGrid(value: number, step: number): number {
  const decimals = decimalsFor(step);
  return decimals === 0 ? Math.round(value) : Number(value.toFixed(decimals));
}

function decimalsFor(step: number): number {
  if (Number.isInteger(step)) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(9, text.length - dot - 1);
}

/**
 * 0..1, which is what a plugin parameter tree and a generic fader speak.
 * A degenerate range would divide by zero, so it reports its minimum.
 */
export function normalizeParam(descriptor: ParamDescriptor, value: number): number {
  const span = descriptor.max - descriptor.min;
  if (span <= 0) return 0;
  const clamped = Math.min(descriptor.max, Math.max(descriptor.min, value));
  switch (descriptor.curve) {
    case 'log':
      return Math.log(clamped / descriptor.min) / Math.log(descriptor.max / descriptor.min);
    case 'exp':
      return Math.sqrt((clamped - descriptor.min) / span);
    default:
      return (clamped - descriptor.min) / span;
  }
}

/** The inverse, snapped onto the grid when there is one. */
export function denormalizeParam(descriptor: ParamDescriptor, unit: number): number {
  const clamped = Math.min(1, Math.max(0, unit));
  const span = descriptor.max - descriptor.min;
  let value: number;
  switch (descriptor.curve) {
    case 'log':
      value = descriptor.min * Math.pow(descriptor.max / descriptor.min, clamped);
      break;
    case 'exp':
      value = descriptor.min + span * clamped * clamped;
      break;
    default:
      value = descriptor.min + clamped * span;
  }
  return quantizeParam(descriptor, value);
}

/**
 * What a control panel writes next to the fader. Presentation only: nothing
 * in crate parses this back, and a host is free to ignore it.
 */
export function formatParam(descriptor: ParamDescriptor, value: number): string {
  switch (descriptor.kind) {
    case 'enum': {
      const index = Math.round(quantizeParam(descriptor, value));
      return descriptor.options[index] ?? String(index);
    }
    case 'toggle':
      return descriptor.labels[value >= 0.5 ? 1 : 0];
    case 'stepped':
      return withUnit(trimNumber(quantizeParam(descriptor, value), decimalsFor(descriptor.step)), descriptor.unit);
    case 'range':
      return withUnit(trimNumber(value, precisionFor(descriptor)), descriptor.unit);
  }
}

/**
 * Enough digits to see a fader move, and no more. A 20 Hz to 20 kHz sweep
 * does not want three decimals; a 0 to 1 mix control is useless without them.
 */
function precisionFor(descriptor: ParamDescriptor): number {
  const span = descriptor.max - descriptor.min;
  if (span >= 100) return 0;
  if (span >= 10) return 1;
  return 2;
}

function trimNumber(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return decimals === 0 ? text : text.replace(/\.?0+$/, '');
}

function withUnit(text: string, unit: string | undefined): string {
  return unit ? `${text} ${unit}` : text;
}

/**
 * The value an enum param should be set to for a named option. Throws rather
 * than returning -1, because a typo'd option name silently selecting the
 * first choice is the exact failure this whole kind exists to prevent.
 */
export function enumValue<T extends string>(
  descriptor: EnumParamDescriptor<T>,
  option: NoInfer<T>,
): number {
  const index = descriptor.options.indexOf(option);
  if (index === -1) {
    throw new RangeError(`param option "${option}" is not one of ${descriptor.options.join(', ')}`);
  }
  return index;
}
