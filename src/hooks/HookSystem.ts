import { CRATE_SLOTS } from './slots';

export type HookContext = Record<string, unknown>;

export interface SlotComponentConfig {
  component?: unknown;
  label?: string;
  icon?: unknown;
  priority?: number;
  condition?: (context: HookContext) => boolean;
  props?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

export interface SlotComponent extends SlotComponentConfig {
  id: string;
  priority: number;
}

export type FilterCallback = (value: unknown, ...args: unknown[]) => unknown;
export type ActionCallback = (...args: unknown[]) => void;
export type WrapperFn = (inner: unknown, context: HookContext) => unknown;

interface PriorityCallback<T> {
  callback: T;
  priority: number;
}

/**
 * WordPress-shaped hooks: filters, actions, and named UI slots.
 * Construct a fresh instance per editor (or per test). `hooks` is the shared
 * default for addons that want the WordPress singleton pattern.
 */
export class HookSystem {
  private filters: Record<string, PriorityCallback<FilterCallback>[]> = {};
  private actions: Record<string, PriorityCallback<ActionCallback>[]> = {};
  private uiSlots: Record<string, SlotComponent[]> = {};
  private componentWrappers: Record<string, Array<{ id: string; wrapper: WrapperFn; priority: number }>> = {};
  private currentContext: HookContext = {};
  private readonly slotListeners = new Map<string, Set<(slotName: string) => void>>();
  private readonly anySlotListeners = new Set<(slotName: string) => void>();

  addFilter(hookName: string, callback: FilterCallback, priority = 10): boolean {
    if (typeof hookName !== 'string' || typeof callback !== 'function') return false;
    if (!this.filters[hookName]) this.filters[hookName] = [];
    this.filters[hookName].push({ callback, priority });
    this.filters[hookName].sort((a, b) => a.priority - b.priority);
    return true;
  }

  applyFilters<T>(hookName: string, value: T, ...args: unknown[]): T {
    if (typeof hookName !== 'string') return value;
    const list = this.filters[hookName];
    if (!list || list.length === 0) return value;
    let next: unknown = value;
    for (const { callback } of list) {
      try {
        next = callback(next, ...args);
      } catch {
        /* keep last good value, matching HookSystem.js */
      }
    }
    return next as T;
  }

  removeFilter(hookName: string, callback?: FilterCallback): boolean {
    if (typeof hookName !== 'string') return false;
    if (!this.filters[hookName]?.length) return false;
    if (!callback) {
      delete this.filters[hookName];
      return true;
    }
    const before = this.filters[hookName].length;
    this.filters[hookName] = this.filters[hookName].filter((item) => item.callback !== callback);
    return this.filters[hookName].length < before;
  }

  hasFilter(hookName: string): boolean {
    return (this.filters[hookName]?.length ?? 0) > 0;
  }

  addAction(hookName: string, callback: ActionCallback, priority = 10): boolean {
    if (typeof hookName !== 'string' || typeof callback !== 'function') return false;
    if (!this.actions[hookName]) this.actions[hookName] = [];
    this.actions[hookName].push({ callback, priority });
    this.actions[hookName].sort((a, b) => a.priority - b.priority);
    return true;
  }

  doAction(hookName: string, ...args: unknown[]): void {
    if (typeof hookName !== 'string') return;
    const list = this.actions[hookName];
    if (!list || list.length === 0) return;
    for (const { callback } of list) {
      try {
        callback(...args);
      } catch {
        /* one broken addon must not kill the rest */
      }
    }
  }

  removeAction(hookName: string, callback?: ActionCallback): boolean {
    if (typeof hookName !== 'string') return false;
    if (!this.actions[hookName]?.length) return false;
    if (!callback) {
      delete this.actions[hookName];
      return true;
    }
    const before = this.actions[hookName].length;
    this.actions[hookName] = this.actions[hookName].filter((item) => item.callback !== callback);
    return this.actions[hookName].length < before;
  }

  hasAction(hookName: string): boolean {
    return (this.actions[hookName]?.length ?? 0) > 0;
  }

  registerSlotComponent(slotName: string, componentId: string, config: SlotComponentConfig): boolean {
    if (typeof slotName !== 'string' || typeof componentId !== 'string') return false;
    if (!this.uiSlots[slotName]) this.uiSlots[slotName] = [];
    this.uiSlots[slotName] = this.uiSlots[slotName].filter((c) => c.id !== componentId);
    this.uiSlots[slotName].push({
      ...config,
      id: componentId,
      priority: config.priority ?? 10,
    });
    this.uiSlots[slotName].sort((a, b) => a.priority - b.priority);
    this.notifySlot(slotName);
    return true;
  }

  getSlotComponents(slotName: string, context: HookContext = {}): SlotComponent[] {
    const list = this.uiSlots[slotName];
    if (!list) return [];
    const merged = { ...this.currentContext, ...context };
    return list.filter((component) => {
      if (typeof component.condition !== 'function') return true;
      try {
        return component.condition(merged);
      } catch {
        return false;
      }
    });
  }

  unregisterSlotComponent(slotName: string, componentId: string): boolean {
    if (!this.uiSlots[slotName]) return false;
    const before = this.uiSlots[slotName].length;
    this.uiSlots[slotName] = this.uiSlots[slotName].filter((c) => c.id !== componentId);
    const removed = this.uiSlots[slotName].length < before;
    if (removed) this.notifySlot(slotName);
    return removed;
  }

  registerComponentWrapper(componentName: string, wrapperId: string, wrapper: WrapperFn, priority = 10): boolean {
    if (typeof componentName !== 'string' || typeof wrapperId !== 'string' || typeof wrapper !== 'function') {
      return false;
    }
    if (!this.componentWrappers[componentName]) this.componentWrappers[componentName] = [];
    this.componentWrappers[componentName] = this.componentWrappers[componentName].filter((w) => w.id !== wrapperId);
    this.componentWrappers[componentName].push({ id: wrapperId, wrapper, priority });
    this.componentWrappers[componentName].sort((a, b) => a.priority - b.priority);
    return true;
  }

  applyComponentWrappers<T>(componentName: string, base: T): T {
    const wrappers = this.componentWrappers[componentName] ?? [];
    return wrappers.reduce((inner, { wrapper }) => {
      try {
        return wrapper(inner, this.currentContext) as T;
      } catch {
        return inner;
      }
    }, base);
  }

  setContext(context: HookContext): void {
    this.currentContext = { ...this.currentContext, ...context };
    this.doAction('context_updated', this.currentContext);
  }

  getContext(): HookContext {
    return { ...this.currentContext };
  }

  registerInspectorPanel(panelId: string, config: SlotComponentConfig): boolean {
    return this.registerSlotComponent(CRATE_SLOTS.inspectorPanels, panelId, { ...config, type: 'inspector-panel' });
  }

  registerMixerStrip(stripId: string, config: SlotComponentConfig): boolean {
    return this.registerSlotComponent(CRATE_SLOTS.mixerChannelStrip, stripId, { ...config, type: 'mixer-strip' });
  }

  registerTransportControl(controlId: string, config: SlotComponentConfig): boolean {
    return this.registerSlotComponent(CRATE_SLOTS.transportBar, controlId, { ...config, type: 'transport-control' });
  }

  registerSettingsPanel(panelId: string, config: SlotComponentConfig): boolean {
    return this.registerSlotComponent(CRATE_SLOTS.settingsPanels, panelId, { ...config, type: 'settings-panel' });
  }

  registerMenuItem(itemId: string, config: SlotComponentConfig): boolean {
    return this.registerSlotComponent(CRATE_SLOTS.menuMore, itemId, { ...config, type: 'menu-item' });
  }

  onSlotChange(slotName: string, listener: (slotName: string) => void): () => void {
    let set = this.slotListeners.get(slotName);
    if (!set) {
      set = new Set();
      this.slotListeners.set(slotName, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  onAnySlotChange(listener: (slotName: string) => void): () => void {
    this.anySlotListeners.add(listener);
    return () => {
      this.anySlotListeners.delete(listener);
    };
  }

  reset(): void {
    this.filters = {};
    this.actions = {};
    this.uiSlots = {};
    this.componentWrappers = {};
    this.currentContext = {};
    this.slotListeners.clear();
    this.anySlotListeners.clear();
  }

  private notifySlot(slotName: string): void {
    const set = this.slotListeners.get(slotName);
    if (set) for (const listener of set) listener(slotName);
    for (const listener of this.anySlotListeners) listener(slotName);
  }
}

export function createHookSystem(): HookSystem {
  return new HookSystem();
}

/** Shared default, matching the WordPress `hookSystem` singleton addons expect. */
export const hooks = new HookSystem();
