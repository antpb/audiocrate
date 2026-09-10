/**
 * One timeline every peer agrees on.
 *
 * Two `AudioContext`s run off two crystals that disagree by tens of parts
 * per million: about 3 ms of drift per minute at 50 ppm. Two peers who each
 * think "start now" will not start together, and they will not stay together.
 *
 * Nothing in a session is scheduled against local time. Everything is
 * scheduled against a **session clock**, and each peer maintains its own
 * mapping from that clock to its own audio clock.
 *
 * ## How the mapping is found
 *
 * The same round trip NTP uses, because the problem is the same and it has a
 * known-good answer. A peer sends its local time, the other stamps receipt
 * and reply, and the round trip gives both the offset and the latency:
 *
 * ```
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *   rtt    =  (t3 - t0) - (t2 - t1)
 * ```
 *
 * A single sample of that is badly wrong on a jittery link, because the
 * formula assumes the two legs took equally long. So keep several and use
 * the one with the **lowest round trip**, not the average. The lowest-RTT
 * sample is the one whose legs had the least room to be asymmetric.
 * Averaging mixes good samples with bad.
 *
 * ## Drift
 *
 * Offset alone is a fixed correction and the crystals keep diverging. So the
 * clock also fits a rate from the oldest and newest accepted samples, and
 * applies it: `session = local * rate + offset`. Until there are two samples
 * far enough apart to measure it, the rate is exactly 1.
 */

export interface ClockSample {
  /** Local time when the request left. */
  t0: number;
  /** Remote time when it arrived. */
  t1: number;
  /** Remote time when the reply left. */
  t2: number;
  /** Local time when the reply arrived. */
  t3: number;
}

export interface SessionClockOptions {
  /** Round trips kept for the lowest-RTT search. */
  windowSize?: number;
  /**
   * Seconds between the oldest and newest sample before a rate is fitted.
   * Too short a baseline measures jitter and calls it drift; a minute of
   * separation resolves the tens of ppm that actually matter.
   */
  minRateBaseline?: number;
  /**
   * Widest rate correction accepted, as a fraction. Crystals disagree by
   * tens of ppm; anything past a few hundred is a bad sample, not a clock.
   */
  maxRateDeviation?: number;
  /**
   * How far the estimate has to move before the published offset follows it,
   * in seconds.
   *
   * Every round trip produces a slightly different number, and republishing
   * each one means anything scheduled against this clock is re-anchored a few
   * times a second. The default is 2 ms.
   */
  toleranceSec?: number;
}

interface AcceptedSample {
  localMid: number;
  offset: number;
  rtt: number;
}

export class SessionClock {
  private samples: AcceptedSample[] = [];
  /** What consumers read. Follows `estimate` only past the tolerance. */
  private offsetValue = 0;
  /** The newest fit, whether or not it was worth publishing. */
  private estimateValue = 0;
  private rateValue = 1;
  private best: AcceptedSample | null = null;
  private readonly windowSize: number;
  private readonly minRateBaseline: number;
  private readonly maxRateDeviation: number;
  private readonly toleranceSec: number;

  constructor(options: SessionClockOptions = {}) {
    this.windowSize = Math.max(1, options.windowSize ?? 16);
    this.minRateBaseline = options.minRateBaseline ?? 20;
    this.maxRateDeviation = options.maxRateDeviation ?? 0.001;
    this.toleranceSec = Math.max(0, options.toleranceSec ?? 0.002);
  }

  /** True once at least one round trip has landed. Before that, this clock is local time. */
  get synchronized(): boolean {
    return this.best !== null;
  }

  /**
   * Published offset in seconds, positive when the session clock is ahead of
   * local. Held still until the estimate moves past the tolerance, so nothing
   * scheduled against this clock is re-anchored by ordinary jitter.
   */
  get offset(): number {
    return this.offsetValue;
  }

  /** The newest fit, before the tolerance. For diagnostics and link-quality UI. */
  get estimatedOffset(): number {
    return this.estimateValue;
  }

  /** Fitted rate. Exactly 1 until there is a long enough baseline to measure otherwise. */
  get rate(): number {
    return this.rateValue;
  }

  /** Round trip of the sample currently in use, in seconds. Useful for a UI, and for deciding what to attempt. */
  get roundTrip(): number | null {
    return this.best?.rtt ?? null;
  }

  /**
   * Files a completed round trip. Samples with a negative or absurd round
   * trip are dropped: a clock that stepped mid-exchange produces arithmetic
   * that looks like a very fast link and is not one.
   */
  addSample(sample: ClockSample): boolean {
    const rtt = sample.t3 - sample.t0 - (sample.t2 - sample.t1);
    if (!Number.isFinite(rtt) || rtt < 0) return false;
    const offset = (sample.t1 - sample.t0 + (sample.t2 - sample.t3)) / 2;
    if (!Number.isFinite(offset)) return false;

    this.samples.push({ localMid: (sample.t0 + sample.t3) / 2, offset, rtt });
    while (this.samples.length > this.windowSize) this.samples.shift();
    this.refit();
    return true;
  }

  private refit(): void {
    // Lowest round trip, not the mean. See the note at the top of the file.
    let best = this.samples[0]!;
    for (const sample of this.samples) if (sample.rtt < best.rtt) best = sample;
    this.best = best;

    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const baseline = last.localMid - first.localMid;
    if (baseline >= this.minRateBaseline) {
      // Offset drifting over a long baseline *is* the rate difference.
      const drift = (last.offset - first.offset) / baseline;
      const rate = 1 + drift;
      this.rateValue = Math.min(1 + this.maxRateDeviation, Math.max(1 - this.maxRateDeviation, rate));
    } else {
      this.rateValue = 1;
    }
    // Anchor the fitted line on the best sample, so the mapping is exact
    // there and the rate only corrects the distance away from it.
    this.estimateValue = best.offset + (this.rateValue - 1) * -best.localMid;
    // First fit always publishes; after that, only a move worth hearing.
    if (this.samples.length === 1 || Math.abs(this.estimateValue - this.offsetValue) > this.toleranceSec) {
      this.offsetValue = this.estimateValue;
    }
  }

  /** Local audio time to session time. */
  toSession(localTime: number): number {
    return localTime * this.rateValue + this.offsetValue;
  }

  /** Session time back to a local time a renderer can schedule against. */
  toLocal(sessionTime: number): number {
    return (sessionTime - this.offsetValue) / this.rateValue;
  }

  /**
   * Resets to unsynchronised. Call it when a peer reconnects: samples from
   * before a network change describe a path that no longer exists.
   */
  reset(): void {
    this.samples = [];
    this.best = null;
    this.offsetValue = 0;
    this.estimateValue = 0;
    this.rateValue = 1;
  }
}

/** A participant in the election: who they are and when they arrived. */
export interface SessionParticipant {
  id: string;
  /** When this peer joined, on any clock all peers can compare. */
  joinedAt: number;
}

/**
 * The peer that owns the session timeline: **the one who has been here
 * longest**, ties broken by smallest id.
 *
 * The first version of this picked the lowest id outright, which is stable
 * and needs no round trip and is wrong. A late joiner whose id happens to
 * sort first takes the timeline away from the person who started the
 * session, mid-session, for no reason a user could ever guess. Longest-present
 * matches what people actually expect ("the first person in the room runs
 * it"), and the id only breaks a tie.
 *
 * Every peer computes the same answer from the same published `joinedAt`
 * values, so there is still no election round trip. Filter to live peers
 * before calling: a peer that has gone silent must drop out of the election,
 * or a departed host holds the timeline forever.
 */
export function sessionHost(participants: readonly SessionParticipant[]): string | null {
  let best: SessionParticipant | null = null;
  for (const participant of participants) {
    if (!best) {
      best = participant;
      continue;
    }
    if (participant.joinedAt < best.joinedAt) best = participant;
    else if (participant.joinedAt === best.joinedAt && participant.id < best.id) best = participant;
  }
  return best?.id ?? null;
}
