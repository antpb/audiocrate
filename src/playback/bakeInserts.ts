import { OfflineRenderer } from '../renderers/OfflineRenderer';
import { materialRegistry, type MaterialRegistry } from '../registry/MaterialRegistry';
import type { AudioBufferLike, Clip } from '../graph/Clip';
import type { Material } from '../graph/Material';
import type { Track } from '../graph/Track';
import type { KernelBinaryMap } from '../renderers/kernel';

export interface BakeTrackInsertsOptions {
  /** Bulk payloads (WASM binaries) by kernel slot, forwarded to each plugin's own `bake`. */
  binaries?: KernelBinaryMap;
  /** Plugin set to consult. Defaults to the shared registry. */
  registry?: MaterialRegistry;
  /** Return a previously baked buffer to skip this clip. */
  reuse?: (track: Track, clip: Clip) => AudioBufferLike | undefined;
  /** Store a freshly baked buffer so a later play can `reuse` it. */
  remember?: (track: Track, clip: Clip, baked: AudioBufferLike) => void;
  /** Called after each clip (baked or reused). May yield to the UI. */
  onClip?: (info: { done: number; total: number; reused: boolean }) => void | Promise<void>;
  /** When set, a `reuse` miss leaves the clip dry instead of baking it here. */
  skipUncached?: boolean;
}

/** The generic path: independent per-channel `OfflineRenderer.render`, no attached kernels. */
async function renderGenericChannel(
  material: Material,
  channelData: Float32Array,
  sampleRate: number,
): Promise<Float32Array> {
  const rendered = OfflineRenderer.render(material.graph, {
    duration: channelData.length / sampleRate,
    sampleRate,
    inputSignal: channelData,
    params: material.snapshotParams(),
  });
  return rendered.samples;
}

/**
 * Renders every clip on tracks that have a bound Material chain through that
 * chain. Must run *before* `transport.play()`: `play()` and
 * `AudioScene.beginPlayback` stay fully synchronous, so WASM setup cannot
 * happen inside them.
 *
 * Materials chain in declared order, each stage's output feeding the next.
 * How a given Material consumes channels is the plugin's own declaration
 * (`bakeMode`), not something crate infers: `per-channel` runs each channel
 * independently, `joint` hands the plugin every channel at once because its
 * stereo behavior is one decision rather than two (mono-summing, channel
 * linking, mid/side). A plugin with no `bake` of its own takes the generic
 * per-channel path, which runs its ASL graph with no kernels attached.
 *
 * No cache of its own: call this again after changing a track's materials,
 * clips, or param values, before the next `play()`. A host that wants to
 * skip a clip it already baked supplies `reuse` / `remember`. `AudioScene`
 * does not watch for those changes itself.
 */
export async function bakeTrackInserts(
  tracks: readonly Track[],
  options: BakeTrackInsertsOptions = {},
): Promise<Map<number, AudioBufferLike>> {
  const registry = options.registry ?? materialRegistry;
  const binaries = options.binaries ?? {};
  const baked = new Map<number, AudioBufferLike>();
  let total = 0;
  for (const track of tracks) {
    if (track.materials.list.length === 0) continue;
    total += track.clips.length;
  }
  let done = 0;

  for (const track of tracks) {
    const materials = track.materials.list;
    if (materials.length === 0) continue;
    for (const scheduled of track.clips) {
      const reused = options.reuse?.(track, scheduled.clip);
      if (reused) {
        baked.set(scheduled.clip.id, reused);
        done += 1;
        await options.onClip?.({ done, total, reused: true });
        continue;
      }
      if (options.skipUncached) {
        done += 1;
        await options.onClip?.({ done, total, reused: false });
        continue;
      }

      const buffer = scheduled.clip.buffer;
      let channels: Float32Array[] = [];
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        channels.push(buffer.getChannelData(ch));
      }

      for (const material of materials) {
        const plugin = registry.forMaterial(material);
        if (plugin?.bake && plugin.bakeMode === 'joint') {
          channels = await plugin.bake(material, channels, buffer.sampleRate, binaries);
        } else if (plugin?.bake) {
          channels = await Promise.all(
            channels.map(async (data) =>
              (await plugin.bake!(material, [data], buffer.sampleRate, binaries))[0] ?? data,
            ),
          );
        } else {
          channels = await Promise.all(
            channels.map((data) => renderGenericChannel(material, data, buffer.sampleRate)),
          );
        }
      }

      const numberOfChannels = buffer.numberOfChannels;
      const length = channels[0]?.length ?? 0;
      const wet: AudioBufferLike = {
        sampleRate: buffer.sampleRate,
        length,
        numberOfChannels,
        getChannelData: (ch: number) => channels[ch]!,
      };
      baked.set(scheduled.clip.id, wet);
      options.remember?.(track, scheduled.clip, wet);
      done += 1;
      await options.onClip?.({ done, total, reused: false });
    }
  }
  return baked;
}
