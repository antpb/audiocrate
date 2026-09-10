import type { TimeContext } from '../Time';
import type { AudioNode3 } from '../graph/AudioNode3';

/**
 * Evaluate every lane on a node at one timeline instant.
 * Missing keys mean the lane has not started (no pre-roll write).
 */
export function evaluateNodeAutomation(
  node: AudioNode3,
  timelineSec: number,
  ctx: TimeContext,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { target, lane } of node.automationLanes) {
    const value = lane.evaluate(timelineSec, ctx);
    if (value !== undefined) out[target] = value;
  }
  return out;
}
