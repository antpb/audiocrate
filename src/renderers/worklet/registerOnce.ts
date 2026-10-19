/**
 * `registerProcessor`, once per name per worklet global, across every copy of
 * audiocrate that has been loaded into it.
 *
 * `registerProcessor` throws `NotSupportedError` on a name it has already
 * seen. Two bundles that each carry audiocrate (two plugins in one XR world,
 * a host entry plus crate's own) both call it with `crate-voice-processor`,
 * and in Chrome the second throw lands inside the module while `addModule`
 * still resolves: the first copy's processor keeps serving and nothing says
 * so. The registry is keyed on `Symbol.for`, which is shared by every module
 * in the realm, so it spans bundles in a way a module-level `Set` cannot.
 *
 * Returns whether this call registered the processor. A skipped registration
 * is reported once on the console, because it means this bundle's DSP is not
 * the one running.
 */
const REGISTRY_KEY = Symbol.for('audiocrate.registeredProcessors');

type ProcessorCtor = new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor;

function registry(): Set<string> {
  const scope = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let names = scope[REGISTRY_KEY];
  if (!names) {
    names = new Set<string>();
    scope[REGISTRY_KEY] = names;
  }
  return names;
}

export function registerProcessorOnce(name: string, ctor: ProcessorCtor): boolean {
  const names = registry();
  if (names.has(name)) {
    console.warn(
      `audiocrate: processor "${name}" is already registered in this worklet; ` +
        'the copy loaded first is the one that runs. Load one audiocrate per ' +
        'AudioContext, or pass a distinct processorName.',
    );
    return false;
  }
  try {
    registerProcessor(name, ctor);
  } catch (error) {
    // Registered by something that does not use this registry: an older
    // audiocrate, or a host's own processor under the same name.
    names.add(name);
    console.warn(`audiocrate: processor "${name}" was not registered: ${String(error)}`);
    return false;
  }
  names.add(name);
  return true;
}
