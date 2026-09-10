# Collaboration

Several peers sharing one live scene.

```ts
import { SceneSync, P2pcfTransport } from 'audiocrate';

const sync = new SceneSync(new P2pcfTransport(signalling), {
  now: () => scene.currentTime,
});

sync.set('gain', 0.8);                  // publish
sync.onPeerState(({ peerId, fields }) => {
  faders[peerId].gain.value = fields.gain;   // receive
});
```

## Audiocrate never opens a socket

The transport is injected. Four methods:

```ts
interface CollabTransport {
  readonly localPeerId: string;
  send(bytes: Uint8Array, to?: string): void;
  onMessage(listener: (from: string, bytes: Uint8Array) => void): () => void;
  onPeerChange(listener: (peers: readonly CollabPeer[]) => void): () => void;
  peers(): readonly CollabPeer[];
  isConnected(): boolean;
  close(): void;
}
```

The session layer is testable with two peers in one process and no network,
which is how it is tested. A host can supply peer-to-peer signalling, a
plain socket, a channel between browser tabs, or a local network link. There
is no cloud inside the library.

Two implementations ship: `LoopbackHub` connects peers inside one process,
with configurable latency, jitter, and packet loss. `P2pcfTransport` adapts
a peer-to-peer signalling client, where a server is touched only for peer
discovery and the data path is peer to peer.

## What crosses the wire

State is sent as a compact binary packet: a short header, a presence mask
naming which fields follow, and only those fields, quantized where full
precision is wasted.

```ts
const codec = new StateCodec([
  { name: 'gain', bit: 0, encoding: { kind: 'q16', min: 0, max: 2 } },
  { name: 'pan',  bit: 1, encoding: { kind: 'q16', min: -1, max: 1 } },
  { name: 'playing', bit: 2, encoding: { kind: 'u8' }, interpolate: 'step' },
]);
```

**A packet is a delta.** Moving one fader sends one number, not the whole
state. Receivers merge into the record they hold. Replacing it blanks every
field the sender did not resend.

**Fields grow append-only.** Fields serialise in ascending bit order, so a
receiver that knows fewer of them reads the prefix it understands and
ignores the rest. An older sender never sets a bit a newer receiver would
read. Neither side has to know the other's version. **Assign a bit once and
never reuse it.** A recycled bit is an old peer decoding the wrong field.

**Fields declare whether they interpolate.** A play flag blended halfway
through its flip reads as neither playing nor stopped. A track index blended
between two and three is track two and a half. Mark those `step`.

## Reading remote state smoothly

Packets arrive late, early, out of order, and sometimes not at all. Applying
each one as it lands produces a fader that jumps, stalls, and jumps further.

Audiocrate keeps a ring of timestamped snapshots per peer and renders slightly
behind the present, interpolating between the two snapshots that bracket
that moment. Out-of-order arrivals are filed in place rather than dropped.
Extrapolation past the newest snapshot is capped, so a peer who goes quiet
freezes rather than sliding off the end of their range.

```ts
sync.stateOf(peerId);    // through the jitter buffer, behind by renderDelay
sync.latestOf(peerId);   // newest received, undelayed
```

Use `stateOf` for anything that should move smoothly. Use `latestOf` for
a value that must not lag but is still per-peer (a local mute on an avatar).
Shared transport commands and mixer writes are discrete edits, not this.

**Do not put audio samples through this.** A tenth of a second of lag is
usable on a meter and wrong for a signal.

## Host devices stay local

Audio and MIDI hardware ports are per machine. They are not session state.

A Line / Mic node captures from this computer's interface. A MIDI In or
MIDI Out node talks to a port on this computer. Another participant
changing "USB interface" or "KeyStep" must not retarget your boxes. Monitor
toggles, sample rate, and buffer size are the same kind of local setting.

`deviceId` on MIDI node data may be saved locally so this machine remembers
a port. `stripHostLocalPatch` removes it before an edit goes on the wire.
`restoreHostLocalPatch` puts this machine's id back after a remote patch
lands and drops any id the sender included. MIDI channel, message, CC
number, and note width are patch settings and do sync.

Crate does not open devices. The host supplies the port and keeps
assignment off the wire.

## The clock

Two audio clocks run off two crystals that disagree by tens of parts per
million: a few milliseconds per minute. Two peers who each decide to
"start now" will not start together, and they will not stay together.

Nothing in a session is scheduled against local time. Everything is
scheduled against a **session clock**, and each peer maintains its own
mapping from that clock to its own audio clock.

```ts
const clock = sync.clockFor(peerId);
clock.synchronized;   // has a round trip landed
clock.offset;         // seconds, positive when the session clock leads
clock.rate;           // fitted drift correction, exactly 1 until measurable
clock.roundTrip;      // link quality
clock.toSession(scene.currentTime);
clock.toLocal(sessionTime);
```

**The lowest round trip wins, not the average.** The arithmetic assumes both
legs of a round trip took equally long. A slow, asymmetric sample is simply
wrong, and averaging it with good ones spreads its error rather than
discarding it.

**The rate is exactly 1 until there is a long enough baseline.** Fitting
drift from a few seconds of samples measures jitter and calls it a crystal
difference.

**The published offset holds still until the estimate moves meaningfully.**
Every round trip produces a slightly different number, and republishing each
one re-anchors anything scheduled against it several times a second.

## Who runs the session

The session has one timeline owner. The rule is **whoever has been here
longest, ties broken by lowest identifier**, with peers who have gone silent
dropping out.

Every peer computes the same answer from the same published arrival times,
so there is no election round trip. A peer that has heard from nobody is its
own authority: there is nothing yet to defer to.

```ts
sync.hostPeerId;
sync.isHost;
```

Lowest identifier alone is stable and needs no communication, but a late
arrival that sorts first would take the timeline from the peer who started
the session.

## Rates

Two rates, not one:

```ts
new SceneSync(transport, { stateRate: 20, heartbeatRate: 1 });
```

A playhead moves constantly. A clock drifts over minutes. Sending both at
the faster rate spends most of a room's bandwidth on a number that did not
change.

Everything that sends checks the link first. A client that queues into a
dead connection looks exactly like one that is working, until the queue is
the leak.

## Discrete edits

Continuous `set` / `peerState` is per-peer: each peer's own faders, playhead,
avatar filter, and so on. A play button, a mute, a clip gain is not that.
Those are one shared fact, and two people writing them at once have to
agree who won.

```ts
sync.sendEdit({
  target: 'transport',
  kind: 'transport',
  value: { action: 'playing', position: 0, bpm: 120 },
});

sync.onEdit((edit) => applySceneEdit(scene, edit));
sync.onConflict(({ target, kept, discarded }) => {
  showConflict(target, discarded.peerId);
});
```

Policy is last-write-wins per `target`, ordered by `(wall time, peerId, seq)`.
The discarded write is not applied and is not retried. `onConflict` exists
so a host can show that two people edited the same thing. Edit time is the
wall clock, not the audio clock: two pages start `performance.now()` and
`AudioContext.currentTime` at different moments, and a later Stop must not
lose to an earlier Play on that account.

Edits send immediately, not on the 20 Hz tick. A late joiner receives the
accepted set once, on first clock contact, so they do not start from an
empty scene.

This is not a CRDT. Concurrent writes to the same target race. Concurrent
writes to different targets do not.

## Binding a scene

`SceneSync` is still the wire and the clock, not the scene. Games keep
calling `set` for per-peer avatars. Binding an `AudioScene` is opt-in:

```ts
const detach = attachAudioScene(sync, scene);
```

That binding:

- Sends transport play / pause / stop / seek / tempo as edits, and applies
  remote ones. The scene must already be started.
- Polls the master mixer on the state tick and sends a mixer edit when
  volume, pan, or mute moved.
- Publishes playhead, playing, and bpm as continuous peer state so a remote
  UI can draw them. Those packets do not seek the local transport.
- Applies remote clip edits (`gainDb`, `fadeInSec`, `fadeOutSec`). Clip
  identity is `clip.id` when both sides share it, otherwise `clip.name`.
  The host still issues clip edits with `sendEdit`; they are not polled.

Unsubscribe with `detach()`. The sync and the scene stay open.

## What is missing

- **Live audio streaming.** This layer syncs state, not the running signal.
  `MESSAGE.blob` is reserved so a host can send files (samples, IRs, NAM
  models) on the same transport. `SceneSync` ignores those packets.
