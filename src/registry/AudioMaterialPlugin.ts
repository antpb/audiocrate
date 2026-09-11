import type { AudioMaterial } from '../graph/AudioMaterial';
import type { AssetRequest } from '../graph/assets';
import type { KernelBinaryMap } from '../renderers/kernel';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';

/**
 * Everything crate needs to know about an AudioMaterial type it did not write.
 *
 * three.js core does not ship anybody's car-paint shader; it ships
 * `ShaderMaterial` and a renderer that can run one. Crate owns the scene
 * graph, the transport, ASL, the renderers, and the loaders. A
 * `AudioMaterialPlugin` supplies one AudioMaterial type and the host-facing behavior
 * crate would otherwise hardcode per plugin.
 *
 * Every field past `kind`, `role`, and `create` is optional. Each one
 * exists because crate previously had a name check in that spot:
 *
 * | Was hardcoded in | Now supplied by |
 * |---|---|
 * | `host/mapPluginSlot.ts` AU subtype checks | `host`, `decodePreset`, `applyPreset` |
 * | `loaders/ProjectLoader.ts` hydrate functions | `assetRequests` |
 * | `host/pdc.ts` latency | `latencySamples` |
 * | `playback/liveVoices.ts` type checks | `bindLiveVoice` |
 * | `playback/bakeInserts.ts` name checks | `bakeMode`, `bake` |
 *
 * A plugin that implements none of them is a pure ASL AudioMaterial with no
 * assets, no kernels, and no host identity.
 */
export interface AudioMaterialPlugin<Preset = unknown> {
  /**
   * Stable registry key, matched against `AudioMaterial.kind`. Must not be
   * `'skip'`, which `mapPluginSlot` reserves for "nothing bound here".
   */
  readonly kind: string;

  /**
   * `insert` processes an input signal and goes on `track.materials`.
   * `instrument` is note-driven and goes on `track.instrument`. The
   * distinction is load-bearing: an instrument in the insert chain would be
   * wired into the reverse path and never hear its own notes.
   */
  readonly role: 'insert' | 'instrument';

  /** Human-facing name, for an inspector. Defaults to `kind`. */
  readonly label?: string;

  /** Builds a fresh AudioMaterial at its default params. */
  create(): AudioMaterial;

  /**
   * The native plugin this AudioMaterial mirrors, if any, so a project referencing
   * that plugin maps onto this AudioMaterial. Purely optional: an AudioMaterial with no
   * native counterpart simply never matches a project slot.
   */
  readonly host?: HostPluginIdentity;

  /** Turns a project's saved state blob into this plugin's own preset shape. */
  decodePreset?(blob: string): Preset;

  /**
   * The preset of a slot with no saved state: a plugin the user just added,
   * or one whose blob failed to decode. Supply it whenever `decodePreset`
   * exists, so a caller never has to distinguish "no preset" from "empty
   * preset". Without it, a freshly added plugin reads as having no preset at
   * all, which callers reasonably mistake for an unmapped slot.
   */
  emptyPreset?(): Preset;

  /** Writes a decoded preset onto an AudioMaterial's params. */
  applyPreset?(material: AudioMaterial, preset: Preset): void;

  /**
   * The files this preset references. The host resolves each one against its
   * own storage and stores the decoded result under `AssetRequest.key`, so
   * crate never learns what a `.nam` file is.
   */
  assetRequests?(preset: Preset): readonly AssetRequest[];

  /**
   * Latency this AudioMaterial adds when it is in the chain, in samples, for
   * plugin delay compensation. Read after assets are hydrated, since latency
   * is often conditional on one (a convolver only costs a partition once an
   * impulse response is actually loaded).
   */
  latencySamples?(material: AudioMaterial): number;

  /**
   * Attaches kernels and assets to a freshly created live voice, before it is
   * connected to anything. This is where `voice.loadKernel(...)` and
   * `voice.sendKernel(...)` are called. Awaited, because WASM instantiation
   * is async and `transport.play()` is not.
   */
  bindLiveVoice?(voice: VoiceHandle, material: AudioMaterial, binaries: KernelBinaryMap): Promise<void> | void;

  /**
   * How offline baking feeds this AudioMaterial. `per-channel` (the default) runs
   * each channel through an independent `OfflineRenderer` pass, which is what
   * a plain effect unit does. `joint` hands over every channel at once, for a
   * AudioMaterial whose stereo behavior is a single decision rather than two
   * independent ones (mono-summing, channel linking, mid/side).
   */
  readonly bakeMode?: 'per-channel' | 'joint';

  /**
   * Offline render. Supply this when the generic `OfflineRenderer` path
   * cannot express the AudioMaterial, which in practice means it has kernels: an
   * offline bake has no worklet to load them into, so the plugin has to drive
   * its own engines here. Omit it and crate uses the generic path.
   */
  bake?(
    material: AudioMaterial,
    channels: readonly Float32Array[],
    sampleRate: number,
    binaries: KernelBinaryMap,
  ): Promise<Float32Array[]>;
}

/**
 * A native plugin's identity, in Audio Unit terms because that is the
 * vocabulary homecrate projects are saved in. A VST3-only plugin can leave
 * these as any stable agreed numbers; crate only ever compares them.
 */
export interface HostPluginIdentity {
  /**
   * e.g. `aufx` (effect), `aumf` (MIDI effect), `aumu` (instrument).
   * Informational. `matchHost` does not compare it: the same product often
   * ships as both `aufx` and `aumf` under one subtype.
   */
  componentType?: number;
  componentSubType: number;
  /** Omit to match any manufacturer, which is usually wrong for a shipping plugin. */
  componentManufacturer?: number;
}
