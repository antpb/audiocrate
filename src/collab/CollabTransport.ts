/**
 * Where the bytes go, and nothing else.
 *
 * `crate/collab` never opens a socket. The transport is injected, the same
 * way `AudioContextLike` and `LiveVoiceRenderer` are, and for the same three
 * reasons: the whole session layer is testable with two peers in one process
 * and no network; a host can supply p2pcf, a plain WebSocket, a `BroadcastChannel`
 * between tabs, or a same-LAN link without crate knowing. There is no
 * cloud inside the library.
 *
 * P2PCF fits this shape: it touches a server only for peer discovery and
 * the data plane is genuinely peer-to-peer over WebRTC. A signaling relay
 * is an opt-in convenience, never a requirement.
 */

export interface CollabPeer {
  id: string;
  /** Whatever the transport knows. Crate does not interpret it. */
  meta?: Readonly<Record<string, unknown>>;
}

export interface CollabTransport {
  /** This peer's id. Stable for the life of the session, and the tiebreak for host selection. */
  readonly localPeerId: string;
  /** Broadcasts to every peer, or sends to one when `to` is given. */
  send(bytes: Uint8Array, to?: string): void;
  /** Registers a receiver. Returns an unsubscribe. */
  onMessage(listener: (from: string, bytes: Uint8Array) => void): () => void;
  /** Peer arrivals and departures. Returns an unsubscribe. */
  onPeerChange(listener: (peers: readonly CollabPeer[]) => void): () => void;
  /** Peers currently reachable, excluding this one. */
  peers(): readonly CollabPeer[];
  /**
   * Whether the link is usable right now. Everything that sends checks this
   * first: a client that queues into a dead connection looks identical to
   * one that is working, right up until the queue is the memory leak.
   */
  isConnected(): boolean;
  close(): void;
}

/**
 * A transport that connects peers inside one process, for tests and for a
 * single-tab demo of a multi-peer session.
 *
 * `latency` and `jitter` are here because a collaboration layer that only
 * works on a perfect link is not one. The tests use them to reorder and
 * delay packets deliberately, which is how the snapshot buffer and the
 * clock's lowest-round-trip rule get exercised at all.
 */
export class LoopbackHub {
  private readonly members = new Map<string, LoopbackTransport>();

  constructor(
    private readonly options: {
      /** One-way delay in seconds. */
      latency?: number;
      /** Random extra delay, up to this many seconds. */
      jitter?: number;
      /** Fraction of packets to drop, 0 to 1. */
      loss?: number;
      /** Injectable so a test is deterministic. */
      random?: () => number;
      /** Injectable so a test does not wait in real time. */
      schedule?: (fn: () => void, delaySec: number) => void;
    } = {},
  ) {}

  join(id: string): LoopbackTransport {
    const transport = new LoopbackTransport(id, this);
    this.members.set(id, transport);
    this.announce();
    return transport;
  }

  leave(id: string): void {
    this.members.delete(id);
    this.announce();
  }

  /** @internal */
  deliver(from: string, bytes: Uint8Array, to?: string): void {
    const random = this.options.random ?? Math.random;
    const schedule =
      this.options.schedule ?? ((fn: () => void, delaySec: number) => setTimeout(fn, delaySec * 1000));
    for (const [id, member] of this.members) {
      if (id === from) continue;
      if (to && id !== to) continue;
      if (this.options.loss && random() < this.options.loss) continue;
      const delay = (this.options.latency ?? 0) + (this.options.jitter ?? 0) * random();
      // A copy per recipient: a transport serializes, and a test that
      // shared one buffer would hide a mutation bug that only appears on a
      // real link.
      const copy = bytes.slice();
      if (delay <= 0) member.receive(from, copy);
      else schedule(() => member.receive(from, copy), delay);
    }
  }

  /** @internal */
  peersFor(id: string): readonly CollabPeer[] {
    return [...this.members.keys()].filter((other) => other !== id).map((other) => ({ id: other }));
  }

  private announce(): void {
    for (const member of this.members.values()) member.notifyPeers();
  }
}

export class LoopbackTransport implements CollabTransport {
  private readonly messageListeners = new Set<(from: string, bytes: Uint8Array) => void>();
  private readonly peerListeners = new Set<(peers: readonly CollabPeer[]) => void>();
  private connected = true;

  constructor(
    readonly localPeerId: string,
    private readonly hub: LoopbackHub,
  ) {}

  send(bytes: Uint8Array, to?: string): void {
    if (!this.connected) return;
    this.hub.deliver(this.localPeerId, bytes, to);
  }

  onMessage(listener: (from: string, bytes: Uint8Array) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onPeerChange(listener: (peers: readonly CollabPeer[]) => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  peers(): readonly CollabPeer[] {
    return this.hub.peersFor(this.localPeerId);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Simulates a link going down without the peer leaving the room. */
  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  close(): void {
    this.connected = false;
    this.messageListeners.clear();
    this.peerListeners.clear();
    this.hub.leave(this.localPeerId);
  }

  /** @internal */
  receive(from: string, bytes: Uint8Array): void {
    if (!this.connected) return;
    for (const listener of this.messageListeners) listener(from, bytes);
  }

  /** @internal */
  notifyPeers(): void {
    const peers = this.peers();
    for (const listener of this.peerListeners) listener(peers);
  }
}
