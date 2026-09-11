import { ASLValue } from './ASLValue';
import { audio, MAIN_PORT, paramNode } from './builders';
import type { ASLNode } from './types';

export interface ASLGraphDescriptor {
  /** Named inputs the builder actually referenced, in first-access order (e.g. `['note', 'velocity']`). */
  readonly inputs: readonly string[];
  readonly output: ASLNode;
  /**
   * How many output channels to evaluate. Omitted means "decide from the
   * graph": one pass for a source, one per channel for anything that reads
   * live audio or asks which channel it is on. Set it to 1 on a graph whose
   * output is a control signal, where a second pass would be pure cost.
   */
  readonly channels?: 1 | 2;
}

/**
 * A Proxy that lazily mints a `param` node the first time a given name is
 * read off it (unless the name is one of `reserved`, which returns a fixed
 * value instead), and remembers every lazily-minted name it ever handed
 * out. This is what lets `ASL.node(({ note, velocity }) => ...)`
 * work without the caller declaring its input names anywhere
 * else: destructuring IS the declaration. `AudioMaterial`
 * reuses this with `params` reserved to a pre-built object, so
 * `({ input, params }) => ...` works the same way.
 */
export function createTrackedInputProxy<TReserved extends Record<string, unknown> = Record<string, never>>(
  reserved: TReserved = {} as TReserved,
): { proxy: Record<string, ASLValue> & TReserved; used: Map<string, ASLValue> } {
  const used = new Map<string, ASLValue>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (Object.prototype.hasOwnProperty.call(reserved, prop)) {
          return (reserved as Record<string, unknown>)[prop];
        }
        let value = used.get(prop);
        if (!value) {
          // `input` is the one name that is live audio rather than a
          // per-block number, so it mints a port (asl/ports.ts) and not a
          // param. It is still tracked, so a graph's declared `inputs` list
          // reads the same as it always did.
          value = prop === MAIN_PORT ? audio.input() : paramNode(prop);
          used.set(prop, value);
        }
        return value;
      },
    },
  );
  return { proxy: proxy as Record<string, ASLValue> & TReserved, used };
}

export const ASL = {
  /**
   * Builds a graph once, at authoring time. The returned descriptor is
   * plain data; nothing here touches an AudioContext or
   * any renderer.
   */
  node(builder: (inputs: Record<string, ASLValue>) => ASLValue): ASLGraphDescriptor {
    const { proxy, used } = createTrackedInputProxy();
    const output = builder(proxy);
    if (!(output instanceof ASLValue)) {
      throw new TypeError(
        'ASL.node builder must return an ASLValue (e.g. the result of filter.lowpass(...) or mix(...)).',
      );
    }
    return { inputs: [...used.keys()], output: output.node };
  },
};
