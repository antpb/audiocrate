/**
 * Several peers sharing one live scene.
 *
 * Nothing in here opens a socket. The transport is injected, so the session
 * layer is testable with two peers in one process. A host may supply p2pcf,
 * a WebSocket, or a same-LAN link.
 */
export {
  CRATE_PROTOCOL_VERSION,
  MESSAGE,
  StateCodec,
  cratePeerCodec,
  CRATE_PEER_FIELDS,
  peerHash,
  quantize16,
  dequantize16,
  type MessageType,
  type FieldEncoding,
  type StateField,
  type DecodedState,
} from './protocol';
export {
  SnapshotBuffer,
  lerp,
  blendRecords,
  recordBlender,
  type Snapshot,
  type SnapshotBufferOptions,
} from './interpolation';
export {
  SessionClock,
  sessionHost,
  type ClockSample,
  type SessionClockOptions,
  type SessionParticipant,
} from './SessionClock';
export {
  LoopbackHub,
  LoopbackTransport,
  type CollabTransport,
  type CollabPeer,
} from './CollabTransport';
export { SceneSync, CRATE_CHANNEL_PREFIX, type SceneSyncOptions, type RemotePeerState } from './SceneSync';
export {
  encodeEdit,
  decodeEdit,
  compareEdits,
  type SceneEdit,
  type EditConflict,
  type EditValue,
} from './edits';
export { attachAudioScene, applySceneEdit } from './attachScene';
export {
  P2pcfTransport,
  p2pcfPeerId,
  type P2pcfLike,
  type P2pcfPeerLike,
  type P2pcfTransportOptions,
} from './P2pcfTransport';
