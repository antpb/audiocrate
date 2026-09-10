import { evaluateHostedAutomation, type HostedAutomationTrack, type HostedAutomationWrite } from '../automation/hosted';
import { paramNameForAddress } from '../graph/param';
import type { Bus } from '../graph/Bus';
import type { Material } from '../graph/Material';
import type { Track } from '../graph/Track';
import type { LiveSceneVoices } from './liveVoices';
import type { VoiceHandle } from '../renderers/WebAudioRenderer';

/** A node whose gain a clip-level automation lane (virtual slot -1, address 0) writes into. */
export interface ClipGainTarget {
  gain: { value: number };
}

export interface HostedAutomationBinding {
  voice: VoiceHandle;
  material: Material;
}

/**
 * Routes a hosted project's automation payload into live voices during
 * playback (`playback/liveVoices.ts`). Baked inserts can't take these
 * writes at all, the audio is already rendered by then, which is exactly
 * why the live path exists.
 *
 * Deliberately has no clock of its own: the host calls `apply(timelineMs)`
 * from whatever progress clock it already runs. Crate is not a DAW UI and
 * does not own a transport tick.
 */
export class HostedAutomationBridge {
  private lanes: HostedAutomationTrack[] = [];
  private bindings = new Map<string, HostedAutomationBinding>();
  private clipGains = new Map<number, ClipGainTarget>();
  private lastWrites = new Map<string, number>();

  /** The payload `buildAutomationPayload` produces. Replacing it clears the write-dedupe cache. */
  setLanes(lanes: HostedAutomationTrack[]): void {
    this.lanes = Array.isArray(lanes) ? lanes : [];
    this.lastWrites.clear();
  }

  get laneCount(): number {
    return this.lanes.length;
  }

  /**
   * Indexes live voices by the hosted `(trackIndex, slotIndex)` pair each
   * Material carries (`Material.hostedSlot`, stamped by `ProjectLoader`).
   * Materials without one are skipped: a Material built by hand has no
   * hosted address, so no hosted lane can target it.
   */
  bind(voices: LiveSceneVoices, tracks: readonly Track[], master: Bus): void {
    this.bindings.clear();
    this.lastWrites.clear();

    const indexChain = (materials: readonly Material[], handles: VoiceHandle[]) => {
      materials.forEach((material, i) => {
        const handle = handles[i];
        const slot = material.hostedSlot;
        if (!handle || !slot) return;
        this.bindings.set(`${slot.trackIndex}:${slot.slotIndex}`, { voice: handle, material });
      });
    };

    indexChain(master.materials.list, voices.master);
    for (const track of tracks) {
      const live = voices.tracks.get(track.id);
      if (!live) continue;
      indexChain(track.materials.list, live.inserts);
      if (track.instrument && live.instrument && track.instrument.hostedSlot) {
        const slot = track.instrument.hostedSlot;
        this.bindings.set(`${slot.trackIndex}:${slot.slotIndex}`, {
          voice: live.instrument,
          material: track.instrument,
        });
      }
    }
  }

  /** Registers the per-track gain node clip-level lanes (virtual slot -1, address 0) write into. */
  setClipGainTarget(trackIndex: number, target: ClipGainTarget): void {
    this.clipGains.set(trackIndex, target);
  }

  clearClipGainTargets(): void {
    this.clipGains.clear();
  }

  /**
   * Evaluates every lane at `timelineMs` and writes the ones that actually
   * moved. Returns the writes it applied, so a host can log or meter them;
   * writes whose target isn't bound are evaluated but not applied, and are
   * not returned.
   */
  apply(timelineMs: number): HostedAutomationWrite[] {
    if (this.lanes.length === 0) return [];
    const applied: HostedAutomationWrite[] = [];

    for (const write of evaluateHostedAutomation(this.lanes, timelineMs)) {
      const key = `${write.trackIndex}:${write.slotIndex}:${write.paramAddress}`;
      const previous = this.lastWrites.get(key);
      // Same tolerance the shipped shim uses: an unchanged lane shouldn't
      // spam the worklet's message port every tick.
      if (previous !== undefined && Math.abs(previous - write.value) <= 0.0001) continue;

      if (write.slotIndex === -1) {
        // Virtual clip-level slot. Address 0 is clip gain; address 1 is
        // pitch cents, which has no node to write to on web (no time-pitch
        // node exists), same skip the shim makes.
        if (write.paramAddress !== 0) continue;
        const target = this.clipGains.get(write.trackIndex);
        if (!target) continue;
        target.gain.value = write.value;
        this.lastWrites.set(key, write.value);
        applied.push(write);
        continue;
      }

      const binding = this.bindings.get(`${write.trackIndex}:${write.slotIndex}`);
      if (!binding) continue;
      const name = paramNameForAddress(binding.material.params, write.paramAddress);
      if (!name) continue;
      binding.voice.setParam(name, write.value);
      this.lastWrites.set(key, write.value);
      applied.push(write);
    }

    return applied;
  }

  /** Drops bindings and dedupe state; lanes stay, so a re-`bind()` after the next `play()` resumes writing. */
  reset(): void {
    this.bindings.clear();
    this.clipGains.clear();
    this.lastWrites.clear();
  }
}
