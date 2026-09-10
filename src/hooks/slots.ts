/**
 * Recommended slot names for a Crate editor. Any string is a valid slot;
 * these are the ones crate names so addons do not invent a parallel set.
 */
export const CRATE_SLOTS = {
  inspectorPanels: 'inspector.panels',
  mixerChannelStrip: 'mixer.channelStrip',
  transportBar: 'transport.bar',
  settingsPanels: 'settings.panels',
  menuMore: 'menu.more',
} as const;

export type CrateSlotName = (typeof CRATE_SLOTS)[keyof typeof CRATE_SLOTS];
