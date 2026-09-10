/**
 * The p2pcf adapter against a fake that reproduces the behaviours which
 * actually caused bugs: `peerclose` handing over the peer object rather than
 * an id, `client_id` differing from `id`, `clientId` being undefined until
 * the first poll, `broadcast` throwing mid-renegotiation, and a room-full
 * event that does not stop the instance.
 *
 * The adapter's only job is translation, and translation is where the bugs
 * are. Whether p2pcf itself works is p2pcf's business, and
 * `check-p2pcf.mjs` answers that against a real worker.
 */
import { describe, expect, it, vi } from 'vitest';
import { P2pcfTransport, p2pcfPeerId, type P2pcfLike, type P2pcfPeerLike } from '../../src/collab/P2pcfTransport';
import { SceneSync } from '../../src/collab/SceneSync';

interface FakeP2pcf extends P2pcfLike {
  emit(event: string, ...args: unknown[]): void;
  sent: Array<{ to: string | null; bytes: Uint8Array }>;
  destroyed: boolean;
  throwOnSend: boolean;
}

function fakeP2pcf(clientId: string | null = 'me'): FakeP2pcf {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const fake: FakeP2pcf = {
    clientId: clientId ?? undefined,
    sent: [],
    destroyed: false,
    throwOnSend: false,
    broadcast(bytes) {
      if (fake.throwOnSend) throw new Error('channel renegotiating');
      fake.sent.push({ to: null, bytes });
    },
    send(peer, bytes) {
      if (fake.throwOnSend) throw new Error('channel renegotiating');
      fake.sent.push({ to: p2pcfPeerId(peer), bytes });
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    destroy() {
      fake.destroyed = true;
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (...a: unknown[]) => void)(...args);
      }
    },
  };
  return fake;
}

const peer = (id: string, clientId?: string): P2pcfPeerLike => ({ id, client_id: clientId });

describe('p2pcf peer identity', () => {
  it('prefers client_id, which is the one that survives a reconnect', () => {
    expect(p2pcfPeerId(peer('session-1', 'alice'))).toBe('alice');
    expect(p2pcfPeerId(peer('session-1'))).toBe('session-1');
  });

  it('keeps a reconnecting peer the same participant', () => {
    // A reconnect gives a new session id and keeps client_id. Keying on the
    // session id would make a returning collaborator arrive as a stranger.
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf);
    p2pcf.emit('peerconnect', peer('session-1', 'alice'));
    p2pcf.emit('peerclose', peer('session-1', 'alice'));
    p2pcf.emit('peerconnect', peer('session-2', 'alice'));
    expect(transport.peers().map((entry) => entry.id)).toEqual(['alice']);
  });
});

describe('p2pcf transport', () => {
  it('surfaces peers as they connect and forgets them as they close', () => {
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf);
    const seen: string[][] = [];
    transport.onPeerChange((peers) => seen.push(peers.map((entry) => entry.id)));

    p2pcf.emit('peerconnect', peer('s1', 'alice'));
    p2pcf.emit('peerconnect', peer('s2', 'bob'));
    // The peer OBJECT, not an id. Reading it as a string here is the bug
    // that leaks whatever the handler was cleaning up.
    p2pcf.emit('peerclose', peer('s1', 'alice'));

    expect(seen).toEqual([['alice'], ['alice', 'bob'], ['bob']]);
    expect(transport.peers().map((entry) => entry.id)).toEqual(['bob']);
  });

  it('delivers messages under the sender is durable id', () => {
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf);
    const received: Array<[string, number]> = [];
    transport.onMessage((from, bytes) => received.push([from, bytes[0]!]));

    p2pcf.emit('msg', peer('s1', 'alice'), new Uint8Array([7]));
    expect(received).toEqual([['alice', 7]]);
  });

  it('accepts a raw ArrayBuffer as well as a view', () => {
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf);
    const received: number[] = [];
    transport.onMessage((_from, bytes) => received.push(bytes[0]!));
    p2pcf.emit('msg', peer('s1', 'alice'), new Uint8Array([9]).buffer);
    expect(received).toEqual([9]);
  });

  it('is not connected before the first poll assigns an id', () => {
    // `clientId` is undefined until p2pcf has polled once, and sending then
    // throws. Reporting disconnected is what stops everything upstream from
    // queueing into it.
    const p2pcf = fakeP2pcf(null);
    const transport = new P2pcfTransport(p2pcf);
    expect(transport.isConnected()).toBe(false);
    transport.send(new Uint8Array([1]));
    expect(p2pcf.sent).toHaveLength(0);

    p2pcf.clientId = 'me';
    expect(transport.isConnected()).toBe(true);
    transport.send(new Uint8Array([1]));
    expect(p2pcf.sent).toHaveLength(1);
  });

  it('swallows a send that throws mid-renegotiation', () => {
    // A dropped state packet is replaced by the next one 50 ms later. A
    // thrown one takes out whatever was iterating peers.
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf);
    p2pcf.throwOnSend = true;
    expect(() => transport.send(new Uint8Array([1]))).not.toThrow();
  });

  it('sends to one peer by id, and not at all to a peer it does not have', () => {
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf);
    p2pcf.emit('peerconnect', peer('s1', 'alice'));

    transport.send(new Uint8Array([1]), 'alice');
    transport.send(new Uint8Array([2]), 'nobody');
    expect(p2pcf.sent).toEqual([{ to: 'alice', bytes: new Uint8Array([1]) }]);
  });

  it('destroys the instance on room-full, because p2pcf does not', () => {
    // Without this the abandoned instance keeps polling for the life of the
    // page, and nothing about it looks wrong from outside.
    const onRoomFull = vi.fn();
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf, { onRoomFull });
    p2pcf.emit('peerconnect', peer('s1', 'alice'));
    p2pcf.emit('roomfullrefresh', peer('s9', 'someone'));

    expect(p2pcf.destroyed).toBe(true);
    expect(onRoomFull).toHaveBeenCalledOnce();
    expect(transport.isConnected()).toBe(false);
    expect(transport.peers()).toEqual([]);
  });

  it('detaches from the instance it attached to', () => {
    const p2pcf = fakeP2pcf();
    const transport = new P2pcfTransport(p2pcf);
    const received: string[] = [];
    transport.onMessage((from) => received.push(from));

    transport.close();
    p2pcf.emit('msg', peer('s1', 'alice'), new Uint8Array([1]));
    expect(received).toEqual([]);
    expect(p2pcf.destroyed).toBe(true);
  });
});

describe('a session over p2pcf', () => {
  it('runs end to end against the adapter', () => {
    // Two fakes wired to each other, so the bytes really do go through
    // `SceneSync` and back out of the codec.
    const alice = fakeP2pcf('alice');
    const bob = fakeP2pcf('bob');
    const aliceTransport = new P2pcfTransport(alice);
    const bobTransport = new P2pcfTransport(bob);

    alice.broadcast = (bytes) => bob.emit('msg', peer('s-alice', 'alice'), bytes);
    bob.broadcast = (bytes) => alice.emit('msg', peer('s-bob', 'bob'), bytes);
    alice.emit('peerconnect', peer('s-bob', 'bob'));
    bob.emit('peerconnect', peer('s-alice', 'alice'));

    const timers: Array<() => void> = [];
    const options = {
      setInterval: (fn: () => void) => timers.push(fn),
      clearInterval: () => {},
      now: () => 0,
      wallNow: () => 1000,
    };
    const a = new SceneSync(aliceTransport, options);
    const b = new SceneSync(bobTransport, options);

    a.set('gain', 0.6);
    timers.forEach((fn) => fn());

    expect(b.latestOf('alice')!.gain).toBeCloseTo(0.6, 3);
    a.close();
    b.close();
  });
});
