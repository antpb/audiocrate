/**
 * `CollabTransport` over p2pcf: WebRTC data channels with Cloudflare only for
 * signaling.
 *
 * p2pcf touches a server only for peer discovery, and the data plane is
 * genuinely peer to peer. A signaling relay is an opt-in convenience
 * rather than a requirement.
 *
 * **Crate does not depend on p2pcf.** The instance is passed in, typed
 * structurally, so the package has no new dependency, a host may pin whatever
 * version it likes, and the adapter is testable against a fake. Crate should
 * no more require a particular signaling library than three.js requires a
 * particular asset CDN.
 *
 * P2pcf pitfalls this adapter accounts for:
 *
 * 1. **`peerclose` hands you the peer object, not an id.** Typing that
 *    argument as a string is silent: the lookup simply never matches, and
 *    whatever the handler was meant to clean up leaks for the life of the
 *    session.
 * 2. **`client_id` is the identity; `id` is the session.** A peer that
 *    reconnects keeps its `client_id` and gets a new `id`. Keying anything
 *    durable on `id` means a reconnecting peer arrives as a stranger.
 * 3. **p2pcf does not stop itself when a room is full.** It emits
 *    `roomfullrefresh` and keeps its polling intervals running. Without a
 *    `destroy()`, the abandoned instance polls forever.
 * 4. **Sending can throw while a channel renegotiates**, so every send is
 *    wrapped. Note what `isConnected()` can and cannot mean here: p2pcf
 *    assigns `clientId` in its constructor, so it is *not* a signal that
 *    signaling has succeeded. It reports "this instance has not been
 *    destroyed", which is the failure that actually matters, because a
 *    broadcast to an empty room is a no-op while a broadcast into a
 *    destroyed instance is not.
 * 5. **Detach from the instance you attached to.** A room-full refresh
 *    replaces the instance, so cleanup that reads a shared reference detaches
 *    from the wrong object.
 * 6. **Two instances in one page never find each other.** They poll happily,
 *    the worker answers 200 with an empty room, and nothing connects; two
 *    browser contexts connect in a few seconds. Worth knowing before writing
 *    a test, or a single-page demo of a multi-peer session.
 */
import type { CollabPeer, CollabTransport } from './CollabTransport';

/** A peer as p2pcf hands it over. */
export interface P2pcfPeerLike {
  /** Per-session id. New on every reconnect. */
  id: string;
  /** The id the peer chose. Stable across reconnects, and the one to key on. */
  client_id?: string;
}

/** The slice of p2pcf this adapter uses. Structural, so crate needs no dependency. */
export interface P2pcfLike {
  /** p2pcf assigns this in its constructor, so it is an id, not a readiness signal. */
  clientId?: string;
  broadcast(bytes: Uint8Array): void;
  send(peer: P2pcfPeerLike, bytes: Uint8Array): void;
  on(event: string, listener: (...args: never[]) => void): void;
  off?(event: string, listener: (...args: never[]) => void): void;
  destroy?(): void;
}

export interface P2pcfTransportOptions {
  /**
   * Called when the room is full. p2pcf does not stop itself here, so this
   * adapter destroys the instance and reports; recreating one with a fresh
   * id is the host's call, since only the host knows what id to use.
   */
  onRoomFull?: () => void;
  /** Reported alongside each peer. Crate does not interpret it. */
  meta?: Readonly<Record<string, unknown>>;
}

/** `client_id` when there is one, the session id when there is not. */
export function p2pcfPeerId(peer: P2pcfPeerLike): string {
  return peer.client_id || peer.id;
}

export class P2pcfTransport implements CollabTransport {
  /** Identity to peer object, because a directed send needs the object. */
  private readonly peerObjects = new Map<string, P2pcfPeerLike>();
  private readonly messageListeners = new Set<(from: string, bytes: Uint8Array) => void>();
  private readonly peerListeners = new Set<(peers: readonly CollabPeer[]) => void>();
  private readonly handlers: Array<[string, (...args: never[]) => void]> = [];
  private destroyed = false;

  constructor(
    private readonly p2pcf: P2pcfLike,
    private readonly options: P2pcfTransportOptions = {},
  ) {
    const onPeerConnect = (peer: P2pcfPeerLike): void => {
      this.peerObjects.set(p2pcfPeerId(peer), peer);
      this.announce();
    };
    // The peer OBJECT, not an id. Reading it as a string here is the leak.
    const onPeerClose = (peer: P2pcfPeerLike): void => {
      this.peerObjects.delete(p2pcfPeerId(peer));
      this.announce();
    };
    const onMessage = (peer: P2pcfPeerLike, data: Uint8Array): void => {
      // p2pcf hands over an ArrayBuffer on some paths and a view on others.
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
      const from = p2pcfPeerId(peer);
      for (const listener of this.messageListeners) listener(from, bytes);
    };
    const onRoomFull = (): void => {
      // Destroy first: the abandoned instance keeps polling otherwise, and
      // the caller cannot know to do it because p2pcf looks fine from outside.
      this.destroyed = true;
      try {
        this.p2pcf.destroy?.();
      } catch {
        /* already gone */
      }
      this.peerObjects.clear();
      this.announce();
      this.options.onRoomFull?.();
    };

    this.listen('peerconnect', onPeerConnect);
    this.listen('peerclose', onPeerClose);
    this.listen('msg', onMessage);
    this.listen('roomfullrefresh', onRoomFull);
  }

  private listen(event: string, handler: (...args: never[]) => void): void {
    this.p2pcf.on(event, handler);
    // Kept so `close()` detaches from *this* instance. A room-full refresh
    // replaces the instance a host holds, and cleanup that reads the shared
    // reference detaches from the wrong object.
    this.handlers.push([event, handler]);
  }

  get localPeerId(): string {
    // Before the first poll there is no id. Empty string rather than a
    // fabricated one: a generated id would be published and then change.
    return this.p2pcf.clientId ?? '';
  }

  /**
   * Whether it is safe to hand this instance bytes. See note 4 above: with
   * p2pcf this is "not destroyed and has an id", not "signaling succeeded",
   * because p2pcf assigns the id locally and never reports readiness.
   */
  isConnected(): boolean {
    return !this.destroyed && typeof this.p2pcf.clientId === 'string' && this.p2pcf.clientId.length > 0;
  }

  send(bytes: Uint8Array, to?: string): void {
    if (!this.isConnected()) return;
    try {
      if (to === undefined) {
        this.p2pcf.broadcast(bytes);
        return;
      }
      const peer = this.peerObjects.get(to);
      if (peer) this.p2pcf.send(peer, bytes);
    } catch {
      // p2pcf throws while a channel is renegotiating. A dropped state packet
      // is replaced by the next one 50 ms later; a thrown one takes out
      // whatever was iterating peers.
    }
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
    return [...this.peerObjects.keys()].map((id) => ({ id, meta: this.options.meta }));
  }

  close(): void {
    this.destroyed = true;
    for (const [event, handler] of this.handlers) this.p2pcf.off?.(event, handler);
    this.handlers.length = 0;
    this.messageListeners.clear();
    this.peerListeners.clear();
    this.peerObjects.clear();
    try {
      this.p2pcf.destroy?.();
    } catch {
      /* already gone */
    }
  }

  private announce(): void {
    const peers = this.peers();
    for (const listener of this.peerListeners) listener(peers);
  }
}
