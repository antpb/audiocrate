import { lerpPoints, mapDisplay127 } from './AutomationLane';

/**
 * The track index a hosted project uses for the master channel. Hosted
 * automation lanes and plugin slots address master by this index, not by
 * a lane track.
 */
export const HOSTED_MASTER_TRACK_INDEX = 100;

/**
 * Project-zip automation payload (buildAutomationPayload). t is 0..1 across
 * FILE duration; values are 0..127.
 */
export interface HostedAutomationLane {
  slotIndex: number;
  paramAddress: number;
  minValue: number;
  maxValue: number;
  points: Array<{ time: number; value: number }>;
}

export interface HostedAutomationClip {
  offsetMs: number;
  trimStartMs: number;
  durationMs: number;
  stretchRatio?: number;
  automationLanes: HostedAutomationLane[];
}

export interface HostedAutomationTrack {
  trackIndex: number;
  clips: HostedAutomationClip[];
}

export interface HostedAutomationWrite {
  trackIndex: number;
  slotIndex: number;
  paramAddress: number;
  value: number;
}

export function evaluateHostedAutomation(
  tracks: HostedAutomationTrack[],
  timelineMs: number,
): HostedAutomationWrite[] {
  const governing = new Map<string, { write: HostedAutomationWrite; clipOffsetMs: number }>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      const ratio = clip.stretchRatio != null && clip.stretchRatio > 0 ? clip.stretchRatio : 1;
      const clipPlayMs = (timelineMs - clip.offsetMs) / ratio + clip.trimStartMs;
      if (clipPlayMs < clip.trimStartMs) continue;
      const duration = Math.max(1, clip.durationMs);
      const t = Math.min(1, Math.max(0, (clipPlayMs - clip.trimStartMs) / duration));
      for (const lane of clip.automationLanes) {
        if (!lane.points || lane.points.length === 0) continue;
        const raw127 = lerpPoints(
          lane.points.map((p) => ({ t: p.time, value: p.value })),
          t,
        );
        const value =
          lane.slotIndex === -1
            ? clipLevelValue(lane.paramAddress, raw127)
            : mapDisplay127(raw127, lane.minValue, lane.maxValue);
        const key = `${track.trackIndex}:${lane.slotIndex}:${lane.paramAddress}`;
        const existing = governing.get(key);
        if (existing && existing.clipOffsetMs >= clip.offsetMs) continue;
        governing.set(key, {
          clipOffsetMs: clip.offsetMs,
          write: {
            trackIndex: track.trackIndex,
            slotIndex: lane.slotIndex,
            paramAddress: lane.paramAddress,
            value,
          },
        });
      }
    }
  }
  return [...governing.values()].map((entry) => entry.write);
}

/** Virtual slot -1: addr 0 is clip gain 0..2, addr 1 is pitch cents. */
export function clipLevelValue(paramAddress: number, raw127: number): number {
  if (paramAddress === 1) return ((raw127 - 64) / 64) * 2400;
  return (raw127 / 127) * 2;
}
