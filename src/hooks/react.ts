import type { HookContext, HookSystem, SlotComponent, SlotComponentConfig } from './HookSystem';
import { hooks as defaultHooks } from './HookSystem';

/**
 * Minimal React surface so crate does not depend on the `react` package.
 * Pass the real React module: `createReactHooks(React)`.
 */
export interface ReactLike {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
}

export function createReactHooks(React: ReactLike, system: HookSystem = defaultHooks) {
  function useUISlots(slotName: string, context: HookContext = {}): SlotComponent[] {
    const [components, setComponents] = React.useState(() => system.getSlotComponents(slotName, context));
    React.useEffect(() => {
      const sync = () => setComponents(system.getSlotComponents(slotName, context));
      sync();
      return system.onSlotChange(slotName, sync);
    }, [slotName, context]);
    return components;
  }

  function useHookContext(context: HookContext): void {
    React.useEffect(() => {
      system.setContext(context);
    }, [context]);
  }

  function useRegisterSlotComponent(slotName: string, componentId: string, config: SlotComponentConfig): void {
    React.useEffect(() => {
      system.registerSlotComponent(slotName, componentId, config);
      return () => {
        system.unregisterSlotComponent(slotName, componentId);
      };
    }, [slotName, componentId, config]);
  }

  return { useUISlots, useHookContext, useRegisterSlotComponent };
}
