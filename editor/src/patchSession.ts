import { P2pcfTransport, SceneSync, restoreHostLocalPatch, stripHostLocalPatch } from '../../src/index';
import type { PortableAsset } from './assetStore';
import {
  assembleAsset,
  decodeAssetChunk,
  decodeAssetOffer,
  encodeAssetChunk,
  encodeAssetOffer,
  isBlobPacket,
  splitAssetBytes,
  assetSetKey,
  peersNeedingAssets,
  type AssetOffer,
} from './assetTransfer';
import type { CratePatch } from './patch';
import { patchFromEdit, publishPatch, publishTransport, transportActionFromEdit, type TransportAction } from './patchEdit';
import { localPeerId } from './sessionUrl';

export const P2PCF_WORKER = 'https://p2pcf.sxp.digital';

export interface TransferProgress {
  direction: 'send' | 'recv';
  label: string;
  done: number;
  total: number;
}

export interface PatchSessionHooks {
  getPatch: () => CratePatch;
  loadPatch: (patch: CratePatch) => Promise<void>;
  listAssets: () => PortableAsset[];
  installAsset: (asset: PortableAsset) => Promise<boolean>;
  onTransport: (action: TransportAction) => void;
  playing: () => boolean;
  onPeers: (count: number) => void;
  onStatus: (message: string) => void;
  onTransfer: (progress: TransferProgress | null) => void;
}

interface IncomingAsset {
  offer: AssetOffer;
  parts: Array<Uint8Array | undefined>;
  got: number;
}

export class PatchSession {
  private sync: SceneSync | null = null;
  private transport: P2pcfTransport | null = null;
  private applying = false;
  private lastJson = '';
  private closed = false;
  private unsubs: Array<() => void> = [];
  private hooks: PatchSessionHooks | null = null;
  private readonly seenPeers = new Set<string>();
  private readonly sentKey = new Map<string, string>();
  private readonly incoming = new Map<string, IncomingAsset>();
  private readonly known = new Set<string>();
  private readonly pending: PortableAsset[] = [];
  private sendChain: Promise<void> = Promise.resolve();
  private sendDone = 0;
  private sendTotal = 0;
  private sendLabel = '';
  private recvDone = 0;
  private recvTotal = 0;
  private recvLabel = '';
  private progressToken = 0;
  private sessionReady = false;

  constructor(readonly roomId: string) {}

  get live(): boolean {
    return this.sync != null && !this.closed;
  }

  publish(patch: CratePatch): void {
    if (!this.sync || this.applying || this.closed) return;
    const json = JSON.stringify(stripHostLocalPatch(patch));
    if (json === this.lastJson) return;
    this.lastJson = json;
    publishPatch(this.sync, patch);
  }

  publishTransport(action: TransportAction): void {
    if (!this.sync || this.applying || this.closed) return;
    publishTransport(this.sync, action);
  }

  pushAssets(to?: string): void {
    this.sendChain = this.sendChain.then(() => this.sendAll(to)).catch(() => undefined);
  }

  async connect(hooks: PatchSessionHooks, publishOnStart: boolean): Promise<void> {
    this.hooks = hooks;
    const P2PCF = (await import('p2pcf')).default;
    if (this.closed) return;
    const workerUrl = import.meta.env.VITE_P2PCF_WORKER || P2PCF_WORKER;
    const p2pcf = new P2PCF(localPeerId(), this.roomId, {
      workerUrl,
      slowPollingRateMs: 1500,
      fastPollingRateMs: 750,
    });
    const transport = new P2pcfTransport(p2pcf, {
      onRoomFull: () => hooks.onStatus('Room is full. Start a new session.'),
    });
    const sync = new SceneSync(transport, { now: () => performance.now() / 1000 });
    this.transport = transport;
    this.sync = sync;
    for (const peer of transport.peers()) this.seenPeers.add(peer.id);
    this.unsubs.push(
      transport.onMessage((_from, bytes) => {
        if (isBlobPacket(bytes)) this.receiveBlob(bytes);
      }),
    );
    this.unsubs.push(
      sync.onEdit((edit) => {
        if (edit.peerId === sync.peerId) return;
        const action = transportActionFromEdit(edit);
        if (action) {
          this.applying = true;
          try {
            hooks.onTransport(action);
          } finally {
            this.applying = false;
          }
          return;
        }
        const patch = patchFromEdit(edit);
        if (!patch) return;
        const merged = restoreHostLocalPatch(patch, hooks.getPatch());
        this.lastJson = JSON.stringify(stripHostLocalPatch(merged));
        this.applying = true;
        void hooks
          .loadPatch(merged)
          .catch((err) => hooks.onStatus(err instanceof Error ? err.message : String(err)))
          .finally(() => {
            this.applying = false;
            this.sessionReady = true;
            void this.flushPending();
          });
      }),
    );
    this.unsubs.push(
      sync.onPeerChange((peers) => {
        hooks.onPeers(peers.length);
        for (const peer of peers) {
          if (this.seenPeers.has(peer.id)) continue;
          this.seenPeers.add(peer.id);
          if (this.sessionReady) this.pushAssets(peer.id);
        }
        const live = new Set(peers.map((peer) => peer.id));
        for (const id of [...this.seenPeers]) if (!live.has(id)) this.seenPeers.delete(id);
      }),
    );
    await p2pcf.start();
    if (this.closed) {
      this.close();
      return;
    }
    if (publishOnStart) {
      this.sessionReady = true;
      this.publish(hooks.getPatch());
      if (hooks.playing()) this.publishTransport('playing');
      for (const peer of transport.peers()) this.pushAssets(peer.id);
    } else {
      const wait = window.setTimeout(() => {
        if (this.closed || this.lastJson !== '') return;
        this.sessionReady = true;
        this.publish(hooks.getPatch());
      }, 8000);
      this.unsubs.push(() => window.clearTimeout(wait));
    }
  }

  close(): void {
    this.closed = true;
    for (const off of this.unsubs) off();
    this.unsubs = [];
    this.sync?.close();
    this.transport?.close();
    this.sync = null;
    this.transport = null;
    this.hooks?.onTransfer(null);
  }

  private receiveBlob(bytes: Uint8Array): void {
    const offer = decodeAssetOffer(bytes);
    if (offer) {
      if (this.known.has(offer.id) || this.incoming.has(offer.id)) return;
      this.known.add(offer.id);
      this.incoming.set(offer.id, { offer, parts: new Array(offer.chunkCount), got: 0 });
      this.recvTotal += offer.byteLength;
      this.recvLabel = offer.filename;
      this.reportTransfer();
      return;
    }
    const chunk = decodeAssetChunk(bytes);
    if (!chunk) return;
    const incoming = this.incoming.get(chunk.id);
    if (!incoming || incoming.parts[chunk.index]) return;
    incoming.parts[chunk.index] = chunk.payload;
    incoming.got += chunk.payload.byteLength;
    this.recvDone += chunk.payload.byteLength;
    this.recvLabel = incoming.offer.filename;
    this.reportTransfer();
    if (incoming.got < incoming.offer.byteLength) return;
    const asset = assembleAsset(incoming.offer, incoming.parts);
    this.incoming.delete(chunk.id);
    if (!asset) return;
    void this.install(asset);
  }

  private async install(asset: PortableAsset): Promise<void> {
    const hooks = this.hooks;
    if (!hooks) return;
    try {
      const ok = await hooks.installAsset(asset);
      if (!ok) {
        this.pending.push(asset);
        return;
      }
      this.reportTransfer();
    } catch (err) {
      hooks.onStatus(err instanceof Error ? err.message : String(err));
    }
  }

  private async flushPending(): Promise<void> {
    const waiting = this.pending.splice(0);
    for (const asset of waiting) await this.install(asset);
  }

  private async sendAll(to?: string): Promise<void> {
    const hooks = this.hooks;
    const transport = this.transport;
    if (!hooks || !transport || this.closed) return;
    const assets = hooks.listAssets();
    if (assets.length === 0) return;
    const key = assetSetKey(assets);
    const peerIds = to ? [to] : transport.peers().map((peer) => peer.id);
    const dest = peersNeedingAssets(peerIds, key, this.sentKey);
    if (dest.length === 0) return;
    const broadcast = !to && dest.length === transport.peers().length;
    this.sendDone = 0;
    this.sendTotal = assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
    if (broadcast) {
      await this.sendAssets(assets);
      if (this.closed) return;
      for (const id of dest) this.sentKey.set(id, key);
      this.reportTransfer();
      return;
    }
    for (const id of dest) {
      if (this.closed) return;
      this.sendDone = 0;
      await this.sendAssets(assets, id);
      this.sentKey.set(id, key);
    }
    this.reportTransfer();
  }

  private async sendAssets(assets: PortableAsset[], to?: string): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    for (const asset of assets) {
      if (this.closed) return;
      this.sendLabel = asset.filename;
      this.reportTransfer();
      transport.send(encodeAssetOffer(asset), to);
      const parts = splitAssetBytes(asset.bytes);
      const id = `${asset.nodeId}:${asset.slot}:${asset.filename}`;
      for (let index = 0; index < parts.length; index++) {
        if (this.closed) return;
        const part = parts[index]!;
        transport.send(encodeAssetChunk(id, index, parts.length, part), to);
        this.sendDone += part.byteLength;
        this.sendLabel = asset.filename;
        this.reportTransfer();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }

  private reportTransfer(): void {
    const hooks = this.hooks;
    if (!hooks) return;
    if (this.recvTotal > 0 && this.recvDone < this.recvTotal) {
      this.progressToken += 1;
      hooks.onTransfer({
        direction: 'recv',
        label: this.recvLabel || 'audio',
        done: this.recvDone,
        total: this.recvTotal,
      });
      return;
    }
    if (this.sendTotal > 0 && this.sendDone < this.sendTotal) {
      this.progressToken += 1;
      hooks.onTransfer({
        direction: 'send',
        label: this.sendLabel || 'audio',
        done: this.sendDone,
        total: this.sendTotal,
      });
      return;
    }
    if (this.recvTotal > 0 && this.recvDone >= this.recvTotal && this.incoming.size === 0) {
      const token = ++this.progressToken;
      hooks.onTransfer({
        direction: 'recv',
        label: this.recvLabel || 'audio',
        done: this.recvTotal,
        total: this.recvTotal,
      });
      window.setTimeout(() => {
        if (this.closed || this.progressToken !== token) return;
        this.recvDone = 0;
        this.recvTotal = 0;
        hooks.onTransfer(null);
      }, 900);
      return;
    }
    if (this.sendTotal > 0 && this.sendDone >= this.sendTotal) {
      const token = ++this.progressToken;
      hooks.onTransfer({
        direction: 'send',
        label: this.sendLabel || 'audio',
        done: this.sendTotal,
        total: this.sendTotal,
      });
      this.sendDone = 0;
      this.sendTotal = 0;
      window.setTimeout(() => {
        if (this.closed || this.progressToken !== token) return;
        hooks.onTransfer(null);
      }, 900);
      return;
    }
    hooks.onTransfer(null);
  }
}
