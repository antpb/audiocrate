/**
 * Several peers sharing one live scene.
 *
 * Assembles the three pieces either side of this file: the presence-mask
 * protocol for what crosses the wire, the snapshot buffer for reading it
 * smoothly, and the session clock for agreeing when. Everything here is
 * transport-agnostic, so a test runs two peers in one process and a host
 * plugs in p2pcf without crate learning what WebRTC is.
 *
 * Rules:
 *
 * 1. **Named channels with a reserved prefix.** Everything crate sends is
 *    under `crate.`; an application's own traffic is not, and cannot
 *    collide with a channel a future crate version adds.
 * 2. **Two identities.** The transport's peer id is the connection; a
 *    session participant is a separate identity. They are not the same
 *    thing: a reconnect is a new connection with the same participant.
 * 3. **Derive, do not send.** Anything a receiver can compute is computed.
 *    A peer sends its fader position, never the gain node's value and the
 *    fader position and the dB reading of both.
 * 4. **Tiered rates.** A playhead moves constantly and needs a high rate; a
 *    name changes once. Sending everything at the fastest thing's rate is
 *    how a room of eight saturates the link.
 * 5. **Check the link before sending.** `isConnected()` first, every time.
 *    A client queueing into a dead connection looks exactly like a working
 *    one until the queue is the memory leak.
 * 6. **Optimistic local application.** Apply a local change immediately,
 *    broadcast it, and reconcile when a conflicting one arrives.
 */
import { SessionClock, sessionHost, type ClockSample, type SessionParticipant } from './SessionClock';
import { SnapshotBuffer, recordBlender } from './interpolation';
import { MESSAGE, StateCodec, cratePeerCodec, peerHash } from './protocol';
import { compareEdits, decodeEdit, encodeEdit, type EditConflict, type EditValue, type SceneEdit } from './edits';
import type { CollabPeer, CollabTransport } from './CollabTransport';

/** Reserved prefix. An application must not use it; a future crate version may. */
export const CRATE_CHANNEL_PREFIX = 'crate.';

export interface SceneSyncOptions {
  /** Defaults to `cratePeerCodec`. An application syncing its own fields supplies its own. */
  codec?: StateCodec;
  /** How often to broadcast continuous state, in Hz. */
  stateRate?: number;
  /** How often to run a clock round trip, in Hz. Slow on purpose: this is drift, not position. */
  heartbeatRate?: number;
  /** Seconds of jitter buffer before remote state is shown. */
  renderDelay?: number;
  /**
   * The clock this peer reads. Defaults to `performance.now()` in seconds.
   * A daw-like session passes `() => scene.currentTime`, so the session timeline
   * is anchored to the audio clock rather than to wall time, which is the
   * only clock that matters for when a sample plays.
   */
  now?: () => number;
  /**
   * Wall clock, for the host election only. Deliberately not `now`: two peers
   * compare arrival times, and their audio clocks start whenever their
   * `AudioContext` did, so they are not comparable at all. Wall time is
   * coarse and good enough, because the only question is who was here first
   * and a tie falls through to the id.
   */
  wallNow?: () => number;
  /**
   * Seconds of silence before a peer drops out of the host election. A peer
   * that has gone quiet must stop being eligible, or a departed host holds
   * the timeline forever.
   */
  peerTimeoutSec?: number;
  /** Injectable timer, so tests do not wait. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type { EditConflict, EditValue, SceneEdit } from './edits';

export interface RemotePeerState {
  peerId: string;
  /** Interpolated to the render time, not the raw last packet. */
  fields: Record<string, number>;
}

type Listener<T> = (value: T) => void;

/**
 * One peer's view of a shared session.
 *
 * Continuous state (`set` / `peerState`) is per-peer: each peer's faders,
 * playhead, and so on. Discrete changes (`sendEdit`) are last-write-wins
 * per `target`. `attachAudioScene` is the binding that applies those to an
 * `AudioScene`. A host that wants something else (eight players' filter
 * cutoffs) keeps calling `set` itself.
 */
export class SceneSync {
  private readonly codec: StateCodec;
  private readonly blend: (
    a: Readonly<Record<string, number>>,
    b: Readonly<Record<string, number>>,
    t: number,
  ) => Record<string, number>;
  private readonly clocks = new Map<string, SessionClock>();
  private readonly buffers = new Map<string, SnapshotBuffer<Record<string, number>>>();
  /**
   * The newest complete state per peer. A packet is a delta (that is what
   * the presence mask is for), so deltas have to merge into the authoritative
   * record and not into whatever the jitter buffer is currently rendering,
   * which is deliberately 100 ms in the past. Merging into the delayed view
   * loses any field set more than one render delay ago.
   */
  private readonly latest = new Map<string, Record<string, number>>();
  private readonly hashToPeer = new Map<number, string>();
  private readonly pendingProbes = new Map<string, { t0: number; sent: number }>();
  private readonly localState: Record<string, number> = {};
  private dirty = new Set<string>();
  private readonly stateListeners = new Set<Listener<RemotePeerState>>();
  private readonly peerListeners = new Set<Listener<readonly CollabPeer[]>>();
  private readonly editListeners = new Set<Listener<SceneEdit>>();
  private readonly conflictListeners = new Set<Listener<EditConflict>>();
  private readonly tickListeners = new Set<() => void>();
  private readonly accepted = new Map<string, SceneEdit>();
  /** Peers already sent the accepted-edit snapshot, so a late joiner catches up once. */
  private readonly snapshotSent = new Set<string>();
  private nextSeq = 1;
  private readonly unsubscribes: Array<() => void> = [];
  private timers: unknown[] = [];
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly renderDelay: number;
  private readonly peerTimeoutSec: number;
  /** When this peer joined, on the wall clock, for the election. */
  private readonly joinedAt: number;
  /** Every peer heard from: when they say they arrived, and when we last heard. */
  private readonly presence = new Map<string, { joinedAt: number; lastSeen: number }>();
  private closed = false;

  constructor(
    private readonly transport: CollabTransport,
    private readonly options: SceneSyncOptions = {},
  ) {
    this.codec = options.codec ?? cratePeerCodec;
    // Which fields must not be interpolated comes from the codec that
    // declared them, so an application adding a flag of its own gets the
    // right behaviour without telling this class about it.
    this.blend = recordBlender(this.codec.stepFields);
    this.now = options.now ?? (() => performance.now() / 1000);
    this.wallNow = options.wallNow ?? (() => Date.now() / 1000);
    this.renderDelay = options.renderDelay ?? 0.1;
    this.peerTimeoutSec = options.peerTimeoutSec ?? 8;
    this.joinedAt = this.wallNow();

    this.unsubscribes.push(transport.onMessage((from, bytes) => this.receive(from, bytes)));
    this.unsubscribes.push(
      transport.onPeerChange((peers) => {
        this.reconcilePeers(peers);
        for (const listener of this.peerListeners) listener(peers);
      }),
    );
    this.reconcilePeers(transport.peers());

    const setTimer = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const stateRate = options.stateRate ?? 20;
    const heartbeatRate = options.heartbeatRate ?? 1;
    // Two rates, not one. A playhead moves every tick and a clock drifts over
    // minutes; sending both at the fast rate wastes most of the bandwidth in
    // the room on a number that did not change.
    this.timers.push(
      setTimer(() => {
        for (const tick of this.tickListeners) tick();
        this.flush();
      }, 1000 / stateRate),
    );
    this.timers.push(setTimer(() => this.probeClocks(), 1000 / heartbeatRate));
  }

  /** This peer's id, as the transport knows it. */
  get peerId(): string {
    return this.transport.localPeerId;
  }

  /**
   * Which peer owns the session timeline: the one who has been here longest,
   * ties broken by smallest id. Every peer computes the same answer from the
   * same published arrival times, so there is no election round trip.
   *
   * A peer that has not been heard from within `peerTimeoutSec` is not
   * eligible. Without that, a host who closes the tab keeps the timeline.
   */
  get hostPeerId(): string | null {
    return sessionHost(this.participants());
  }

  /** Live participants, this peer included, as the election sees them. */
  participants(): readonly SessionParticipant[] {
    const cutoff = this.wallNow() - this.peerTimeoutSec;
    const live: SessionParticipant[] = [{ id: this.peerId, joinedAt: this.joinedAt }];
    for (const peer of this.transport.peers()) {
      const seen = this.presence.get(peer.id);
      // A peer that has connected but not yet spoken is present but has no
      // arrival time to compare, so it sorts after anyone who has: it cannot
      // take the timeline on the strength of not having said anything.
      if (!seen) continue;
      if (seen.lastSeen < cutoff) continue;
      live.push({ id: peer.id, joinedAt: seen.joinedAt });
    }
    return live;
  }

  get isHost(): boolean {
    return this.hostPeerId === this.peerId;
  }

  /** The clock for one peer, for a UI that wants to show link quality. */
  clockFor(peerId: string): SessionClock | undefined {
    return this.clocks.get(peerId);
  }

  /**
   * Sets one field of this peer's state. Marked dirty and sent on the next
   * tick rather than immediately: a fader drag produces hundreds of these
   * and the room only needs the latest.
   */
  set(field: string, value: number): void {
    if (this.localState[field] === value) return;
    this.localState[field] = value;
    this.dirty.add(field);
  }

  /** Everything this peer is currently publishing. */
  get published(): Readonly<Record<string, number>> {
    return this.localState;
  }

  /**
   * Reads a peer's state as of now, interpolated through the jitter buffer,
   * which means it is deliberately `renderDelay` behind. Returns null for a
   * peer that has sent nothing yet.
   */
  stateOf(peerId: string): Record<string, number> | null {
    return this.buffers.get(peerId)?.sample(this.now()) ?? null;
  }

  /**
   * The newest state received from a peer, with no jitter buffering. For
   * a per-peer value that must act on the latest packet rather than show a
   * smooth one. Shared transport commands and mixer writes use `sendEdit`.
   * Prefer `stateOf` for anything a person is watching move.
   */
  latestOf(peerId: string): Record<string, number> | null {
    return this.latest.get(peerId) ?? null;
  }

  /** Fires per incoming packet, with the interpolated value at that moment. */
  onPeerState(listener: Listener<RemotePeerState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onPeerChange(listener: Listener<readonly CollabPeer[]>): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  /**
   * Runs once per state tick, before `flush`. Used by `attachAudioScene` to
   * sample mixer values without a second timer.
   */
  onTick(listener: () => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onEdit(listener: Listener<SceneEdit>): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  onConflict(listener: Listener<EditConflict>): () => void {
    this.conflictListeners.add(listener);
    return () => this.conflictListeners.delete(listener);
  }

  /**
   * Issues a discrete edit immediately (not on the 20 Hz tick). Applied
   * locally first, then sent. A later conflicting write to the same
   * `target` wins on `(wall time, peerId, seq)`; the loser is dropped and
   * `onConflict` fires. Wall time, not `now()`: `now` is often an audio
   * clock that starts when the page does, so a later Stop from a joiner
   * would otherwise lose to an earlier Play.
   */
  sendEdit(input: { target: string; kind: string; value?: EditValue }): SceneEdit | null {
    if (this.closed) return null;
    const edit: SceneEdit = {
      seq: this.nextSeq++,
      time: this.wallNow(),
      peerId: this.peerId,
      target: input.target,
      kind: input.kind,
      value: input.value ?? {},
    };
    const kept = this.acceptEdit(edit);
    if (kept !== edit) return kept;
    if (!this.closed && this.transport.isConnected()) {
      this.transport.send(encodeEdit(edit));
    }
    return edit;
  }

  /**
   * Sends whatever changed since the last tick, and nothing when nothing did.
   * A silent peer costs the room nothing, which is what the presence mask is
   * for.
   */
  flush(): void {
    if (this.closed || this.dirty.size === 0) return;
    // Every send checks the link first. A queue into a dead connection is
    // indistinguishable from working, until it is the leak.
    if (!this.transport.isConnected()) return;

    const changed: Record<string, number> = {};
    for (const field of this.dirty) changed[field] = this.localState[field]!;
    this.dirty = new Set();
    this.transport.send(this.codec.encode(this.peerId, changed));
  }

  private probeClocks(): void {
    if (this.closed || !this.transport.isConnected()) return;
    const t0 = this.now();
    for (const peer of this.transport.peers()) {
      this.pendingProbes.set(peer.id, { t0, sent: t0 });
      this.transport.send(encodeHeartbeat(this.peerId, 0, t0, 0, this.joinedAt), peer.id);
    }
  }

  private receive(from: string, bytes: Uint8Array): void {
    if (this.closed || bytes.length < 2) return;
    const type = bytes[1];
    if (type === MESSAGE.heartbeat) {
      this.receiveHeartbeat(from, bytes);
      return;
    }
    if (type === MESSAGE.edit) {
      const edit = decodeEdit(bytes, from);
      if (edit) this.acceptEdit(edit);
      return;
    }
    if (type !== MESSAGE.peerState) return;
    const decoded = this.codec.decode(bytes);
    if (!decoded) return;

    // The hash is a bandwidth optimisation, not an identity: resolve it
    // against the peers actually present rather than trusting it.
    this.hashToPeer.set(decoded.peerHash, from);

    let buffer = this.buffers.get(from);
    if (!buffer) {
      buffer = new SnapshotBuffer(this.blend, { renderDelay: this.renderDelay });
      this.buffers.set(from, buffer);
    }

    // Stamped with the sender's session time translated into ours, so a
    // packet describes when it was true rather than when it arrived.
    const clock = this.clocks.get(from);
    const merged = { ...(this.latest.get(from) ?? {}), ...decoded.fields };
    this.latest.set(from, merged);
    const stamp = clock?.synchronized ? clock.toLocal(clock.toSession(this.now())) : this.now();
    buffer.push(stamp, merged);

    const interpolated = buffer.sample(this.now()) ?? merged;
    for (const listener of this.stateListeners) listener({ peerId: from, fields: interpolated });
  }

  private receiveHeartbeat(from: string, bytes: Uint8Array): void {
    const probe = decodeHeartbeat(bytes);
    if (!probe) return;
    // Presence rides the clock probe rather than needing its own message:
    // every peer already sends one, and the election needs exactly this.
    const seen = this.presence.get(from);
    this.presence.set(from, {
      joinedAt: seen?.joinedAt ?? probe.joinedAt,
      lastSeen: this.wallNow(),
    });
    // A late joiner has an empty accepted map. Replay once, on first
    // contact, after they are listening. Join-time replay is too early:
    // the hub announces the peer before `SceneSync` subscribes.
    if (!this.snapshotSent.has(from)) {
      this.snapshotSent.add(from);
      this.replayEdits(from);
    }
    if (probe.stage === 0) {
      // A request: stamp arrival and reply. The reply carries both remote
      // stamps so the asker can do the arithmetic without a third leg.
      const t1 = this.now();
      this.transport.send(encodeHeartbeat(this.peerId, 1, probe.t0, t1, this.joinedAt), from);
      return;
    }
    const pending = this.pendingProbes.get(from);
    if (!pending || pending.t0 !== probe.t0) return;
    this.pendingProbes.delete(from);

    let clock = this.clocks.get(from);
    if (!clock) {
      clock = new SessionClock();
      this.clocks.set(from, clock);
    }
    const sample: ClockSample = { t0: probe.t0, t1: probe.t1, t2: probe.t1, t3: this.now() };
    clock.addSample(sample);
  }

  /**
   * Last-write-wins for one target. Returns the edit that is now accepted
   * (the incoming one, or the one already kept).
   */
  private acceptEdit(edit: SceneEdit): SceneEdit {
    const current = this.accepted.get(edit.target);
    if (!current || compareEdits(edit, current) > 0) {
      this.accepted.set(edit.target, edit);
      if (current && current.peerId !== edit.peerId) {
        const conflict = { target: edit.target, kept: edit, discarded: current };
        for (const listener of this.conflictListeners) listener(conflict);
      }
      for (const listener of this.editListeners) listener(edit);
      return edit;
    }
    if (compareEdits(edit, current) < 0) {
      const conflict = { target: edit.target, kept: current, discarded: edit };
      for (const listener of this.conflictListeners) listener(conflict);
    }
    return current;
  }

  private replayEdits(to: string): void {
    if (this.closed || !this.transport.isConnected() || this.accepted.size === 0) return;
    for (const edit of this.accepted.values()) {
      this.transport.send(encodeEdit(edit), to);
    }
  }

  private reconcilePeers(peers: readonly CollabPeer[]): void {
    const present = new Set(peers.map((peer) => peer.id));
    for (const id of [...this.buffers.keys()]) if (!present.has(id)) this.buffers.delete(id);
    for (const id of [...this.latest.keys()]) if (!present.has(id)) this.latest.delete(id);
    for (const id of [...this.presence.keys()]) if (!present.has(id)) this.presence.delete(id);
    for (const id of [...this.clocks.keys()]) if (!present.has(id)) this.clocks.delete(id);
    for (const id of [...this.pendingProbes.keys()]) if (!present.has(id)) this.pendingProbes.delete(id);
    for (const [hash, id] of [...this.hashToPeer]) if (!present.has(id)) this.hashToPeer.delete(hash);
    for (const id of [...this.snapshotSent]) if (!present.has(id)) this.snapshotSent.delete(id);
  }

  close(): void {
    this.closed = true;
    const clearTimer = this.options.clearInterval ?? ((handle: unknown) => clearInterval(handle as never));
    for (const timer of this.timers) clearTimer(timer);
    this.timers = [];
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.stateListeners.clear();
    this.peerListeners.clear();
    this.editListeners.clear();
    this.conflictListeners.clear();
    this.tickListeners.clear();
  }
}

/**
 * A clock round trip. Not a `StateCodec` message: the two timestamps need
 * full float64 precision, and quantizing the thing that measures
 * milliseconds would be self-defeating.
 */
function encodeHeartbeat(id: string, stage: 0 | 1, t0: number, t1: number, joinedAt: number): Uint8Array {
  const bytes = new Uint8Array(4 + 1 + 24);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = MESSAGE.heartbeat;
  view.setUint16(2, peerHash(id), true);
  bytes[4] = stage;
  view.setFloat64(5, t0, true);
  view.setFloat64(13, t1, true);
  // Wall clock, and full precision. It decides who runs the session.
  view.setFloat64(21, joinedAt, true);
  return bytes;
}

function decodeHeartbeat(bytes: Uint8Array): { stage: number; t0: number; t1: number; joinedAt: number } | null {
  if (bytes.length < 29) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    stage: bytes[4]!,
    t0: view.getFloat64(5, true),
    t1: view.getFloat64(13, true),
    joinedAt: view.getFloat64(21, true),
  };
}
