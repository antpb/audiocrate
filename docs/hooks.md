# Hooks

Named points where other code can modify a value, observe an event, or place
a component.

```ts
import { hooks, CRATE_SLOTS } from 'audiocrate';

hooks.addFilter('track.contextMenu', (items, track) => [
  ...items,
  { label: 'Analyse', onSelect: () => analyse(track) },
]);

hooks.addAction('transport.play', (position) => log('rolling from', position));

hooks.registerInspectorPanel('acme.tuner', {
  component: TunerPanel,
  label: 'Tuner',
  condition: (ctx) => ctx.selection === 'track',
});
```

## Three kinds of extension point

**A filter** takes a value and returns it, possibly changed. Filters run in
priority order, each receiving the previous one's output.

**An action** observes. It returns nothing and cannot change anything. If a
hook's callers care what comes back, it is a filter.

**A slot** is a place in an interface where components can be added by name.

```ts
hooks.addFilter(name, callback, priority = 10);
hooks.applyFilters(name, value, ...args);
hooks.removeFilter(name, callback?);
hooks.hasFilter(name);

hooks.addAction(name, callback, priority = 10);
hooks.doAction(name, ...args);
hooks.removeAction(name, callback?);
hooks.hasAction(name);
```

Any string is a valid hook name. There is no registry to declare one in and
no build step to regenerate. An addon can define a hook that only it and
one other addon know about.

## A broken addon does not take down the host

Every callback runs inside a guard. A filter that throws is skipped and the
last good value carries forward. An action that throws does not stop the
remaining actions from running. A slot condition that throws hides that
component rather than blanking the panel.

An uncaught exception would take down the host. A failure in an extension
costs the extension.

## UI slots

A slot holds named components with priorities and optional conditions.

```ts
hooks.registerSlotComponent('mixer.channelStrip', 'acme.meter', {
  component: MeterStrip,
  priority: 5,
  condition: (ctx) => ctx.track?.hasAudio,
  props: { scale: 'peak' },
});

hooks.getSlotComponents('mixer.channelStrip', { track });
hooks.unregisterSlotComponent('mixer.channelStrip', 'acme.meter');
```

Registering the same id twice replaces rather than duplicating, so a
hot-reload during development does not leave two of everything.

`getSlotComponents` merges the ambient context with the one you pass, so a
condition can read both what is globally true and what is true at this call
site.

### The named slots

Any string works, but an addon that invents its own name will not appear
anywhere. These are the ones an editor is expected to render:

| `CRATE_SLOTS` | Name | |
|---|---|---|
| `inspectorPanels` | `inspector.panels` | Panels for whatever is selected |
| `mixerChannelStrip` | `mixer.channelStrip` | Per-channel additions |
| `transportBar` | `transport.bar` | Controls beside play and stop |
| `settingsPanels` | `settings.panels` | Application preferences |
| `menuMore` | `menu.more` | Overflow menu items |

Convenience methods register into them and tag the entry with its type:

```ts
hooks.registerInspectorPanel(id, config);
hooks.registerMixerStrip(id, config);
hooks.registerTransportControl(id, config);
hooks.registerSettingsPanel(id, config);
hooks.registerMenuItem(id, config);
```

### Wrapping a component

A wrapper takes a component and returns a replacement. Wrappers compose in
priority order.

```ts
hooks.registerComponentWrapper('TrackHeader', 'acme.badge', (inner, ctx) =>
  withBadge(inner, ctx),
);

const Header = hooks.applyComponentWrappers('TrackHeader', BaseHeader);
```

This is for changing something that already exists rather than adding beside
it: a badge on a track header, a border on a selected clip.

## Context

Context is ambient state that conditions and wrappers read: current
selection, editor mode, and whatever else the host puts there.

```ts
hooks.setContext({ selection: 'track', trackId: track.id });
hooks.getContext();
```

Setting context merges rather than replaces, and fires the `context_updated`
action.

## React

Audiocrate does not depend on React. The binding is a function you hand React:

```ts
import React from 'react';
import { createReactHooks } from 'audiocrate';

const { useUISlots, useHookContext, useRegisterSlotComponent } =
  createReactHooks(React);

function ChannelStrip({ track }) {
  useHookContext({ trackId: track.id });
  const extras = useUISlots(CRATE_SLOTS.mixerChannelStrip, { track });
  return extras.map(({ id, component: C, props }) => <C key={id} {...props} />);
}
```

`useUISlots` re-renders when that slot changes, so an addon registering
after first paint appears without a reload. `useRegisterSlotComponent`
unregisters on unmount.

The same pattern works for any framework: `onSlotChange` and
`onAnySlotChange` return unsubscribe functions and know nothing about React.

## One system or several

```ts
import { hooks, createHookSystem } from 'audiocrate';
```

`hooks` is a shared default. An addon loaded by an application it does not
control registers there.

`createHookSystem()` makes an isolated one. Two editors in one page, or a
test that must not see another test's registrations, want their own.

`reset()` clears everything, which is mostly a testing tool.

## What is missing

- **Audiocrate core fires no hooks of its own.** The system is complete and the
  named slots are agreed. The set of filter and action names the library
  itself calls is not yet done, so an addon cannot change a Audiocrate value
  without the host arranging it. Until then, hooks extend the application
  around Audiocrate.
- **No sandboxing.** A callback is ordinary code with ordinary access.
  Exceptions are contained; capabilities are not. Loading an addon is
  trusting its author. Portable kernels solve that for the audio thread.
  Nothing here does.
- **No dependency or ordering declarations.** Priority numbers are the only
  ordering tool, and two addons that both pick 10 resolve by registration
  order.
- **No manifest or discovery.** How addons are found, loaded, enabled, and
  persisted is the host's business. Audiocrate provides the wiring, not the
  package manager.
