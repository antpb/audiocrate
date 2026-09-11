import type { AutomationLane } from '../automation/AutomationLane';
import { AudioMaterialChain } from './AudioMaterial';

export interface AudioNode3Options {
  name?: string;
}

let nextAudioNode3Id = 1;

/**
 * Shared mixer fields for `Track` and `Bus`: volume, pan, mute, and a
 * AudioMaterial chain. Not a transform hierarchy.
 */
export abstract class AudioNode3 {
  readonly id: number = nextAudioNode3Id++;
  name: string;
  readonly materials = new AudioMaterialChain();

  /**
   * Equal-power pan crosspoint, -1 (full left) to 1 (full right). Averages
   * rather than sums; not a linear law.
   */
  pan = 0;

  /**
   * Linear gain, matching a DAW per-channel volume fader.
   */
  volume = 1;

  /** Silences the node without changing `volume`. */
  muted = false;

  /**
   * Reported plugin latency in samples, for PDC. Summed from whatever this
   * node's Materials report through their plugins (`chainLatencySamples`);
   * crate has no per-plugin numbers of its own. Dry tracks stay 0. The
   * wettest track starts first; drier tracks wait.
   */
  latencySamples = 0;

  private readonly automation: Array<{ target: string; lane: AutomationLane }> = [];

  constructor(options: AudioNode3Options = {}) {
    this.name = options.name ?? this.constructor.name;
  }

  /** `target` is an AudioMaterial param name or `gain` / `pan`. */
  automate(target: string, lane: AutomationLane): void {
    this.automation.push({ target, lane });
  }

  get automationLanes(): readonly { target: string; lane: AutomationLane }[] {
    return this.automation;
  }
}
