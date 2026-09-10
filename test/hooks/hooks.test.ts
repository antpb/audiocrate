import { describe, expect, it } from 'vitest';
import { createHookSystem } from '../../src/hooks/HookSystem';
import { CRATE_SLOTS } from '../../src/hooks/slots';
import { createReactHooks } from '../../src/hooks/react';

describe('filters and actions', () => {
  it('pipes a value through filters in priority order (lower first)', () => {
    const h = createHookSystem();
    h.addFilter('label', (v) => `${v}!`, 20);
    h.addFilter('label', (v) => `${v}?`, 5);
    expect(h.applyFilters('label', 'cut')).toBe('cut?!');
  });

  it('passes extra args and keeps the last good value if a filter throws', () => {
    const h = createHookSystem();
    h.addFilter('n', (v, extra) => (v as number) + (extra as number));
    h.addFilter('n', () => {
      throw new Error('boom');
    });
    h.addFilter('n', (v) => (v as number) * 2);
    expect(h.applyFilters('n', 1, 3)).toBe(8);
  });

  it('removeFilter by callback or by hook name', () => {
    const h = createHookSystem();
    const cb = (v: unknown) => `${v}x`;
    h.addFilter('a', cb);
    expect(h.removeFilter('a', cb)).toBe(true);
    expect(h.applyFilters('a', 'z')).toBe('z');
    h.addFilter('a', cb);
    expect(h.removeFilter('a')).toBe(true);
    expect(h.hasFilter('a')).toBe(false);
  });

  it('runs actions in priority order and isolates throws', () => {
    const h = createHookSystem();
    const seen: string[] = [];
    h.addAction('go', () => seen.push('b'), 20);
    h.addAction('go', () => {
      throw new Error('no');
    }, 10);
    h.addAction('go', () => seen.push('a'), 10);
    h.doAction('go');
    expect(seen).toEqual(['a', 'b']);
  });

  it('rejects invalid registration the same way HookSystem.js does', () => {
    const h = createHookSystem();
    expect(h.addFilter('', null as never)).toBe(false);
    expect(h.addAction(1 as never, () => {})).toBe(false);
  });
});

describe('slots', () => {
  it('sorts by priority and replaces the same id', () => {
    const h = createHookSystem();
    h.registerSlotComponent('inspector.panels', 'eq', { label: 'EQ', priority: 20 });
    h.registerSlotComponent('inspector.panels', 'gain', { label: 'Gain', priority: 5 });
    h.registerSlotComponent('inspector.panels', 'eq', { label: 'EQ2', priority: 20 });
    expect(h.getSlotComponents('inspector.panels').map((c) => c.id)).toEqual(['gain', 'eq']);
    expect(h.getSlotComponents('inspector.panels')[1]!.label).toBe('EQ2');
  });

  it('hides a component when condition is false or throws', () => {
    const h = createHookSystem();
    h.setContext({ pro: false });
    h.registerInspectorPanel('pro-only', {
      label: 'Pro',
      condition: (ctx) => ctx.pro === true,
    });
    h.registerInspectorPanel('broken', {
      label: 'X',
      condition: () => {
        throw new Error('no');
      },
    });
    expect(h.getSlotComponents(CRATE_SLOTS.inspectorPanels)).toHaveLength(0);
    expect(h.getSlotComponents(CRATE_SLOTS.inspectorPanels, { pro: true })).toHaveLength(1);
  });

  it('notifies subscribers on register and unregister', () => {
    const h = createHookSystem();
    const hits: string[] = [];
    const off = h.onSlotChange('transport.bar', (name) => hits.push(name));
    h.registerTransportControl('play', { label: 'Play' });
    h.unregisterSlotComponent('transport.bar', 'play');
    off();
    h.registerTransportControl('stop', { label: 'Stop' });
    expect(hits).toEqual(['transport.bar', 'transport.bar']);
  });
});

describe('wrappers and context', () => {
  it('applies wrappers inner-first (lower priority closer to the base)', () => {
    const h = createHookSystem();
    h.registerComponentWrapper('Knob', 'outer', (inner) => `outer(${inner})`, 20);
    h.registerComponentWrapper('Knob', 'inner', (inner) => `inner(${inner})`, 5);
    expect(h.applyComponentWrappers('Knob', 'base')).toBe('outer(inner(base))');
  });

  it('setContext merges and fires context_updated', () => {
    const h = createHookSystem();
    const seen: unknown[] = [];
    h.addAction('context_updated', (ctx) => seen.push(ctx));
    h.setContext({ track: 1 });
    h.setContext({ material: 'amp' });
    expect(h.getContext()).toEqual({ track: 1, material: 'amp' });
    expect(seen).toHaveLength(2);
  });

  it('two systems never share slots', () => {
    const a = createHookSystem();
    const b = createHookSystem();
    a.registerMixerStrip('fader', { label: 'A' });
    expect(b.getSlotComponents(CRATE_SLOTS.mixerChannelStrip)).toHaveLength(0);
  });

  it('reset clears everything', () => {
    const h = createHookSystem();
    h.addFilter('x', (v) => v);
    h.registerMenuItem('export', { label: 'Export' });
    h.reset();
    expect(h.hasFilter('x')).toBe(false);
    expect(h.getSlotComponents(CRATE_SLOTS.menuMore)).toHaveLength(0);
  });
});

describe('createReactHooks', () => {
  it('useUISlots reads the current slot and resubscribes on change', () => {
    const h = createHookSystem();
    h.registerInspectorPanel('params', { label: 'Params' });
    let state: unknown = null;
    let effectCleanup: (() => void) | undefined;
    const React = {
      useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
        const value = typeof initial === 'function' ? (initial as () => T)() : initial;
        state = value;
        return [
          value,
          (next) => {
            state = typeof next === 'function' ? (next as (prev: T) => T)(state as T) : next;
          },
        ];
      },
      useEffect(effect: () => void | (() => void)) {
        effectCleanup = effect() ?? undefined;
      },
    };
    const { useUISlots } = createReactHooks(React, h);
    const first = useUISlots('inspector.panels');
    expect(first).toHaveLength(1);
    h.registerInspectorPanel('extra', { label: 'Extra' });
    expect((state as { length: number }).length).toBe(2);
    effectCleanup?.();
  });
});
