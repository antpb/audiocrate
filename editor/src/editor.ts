import { ClassicPreset, GetSchemes, NodeEditor } from 'rete';
import { AreaExtensions, AreaPlugin } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { Presets, ReactArea2D, ReactPlugin } from 'rete-react-plugin';
import { createRoot } from 'react-dom/client';
import {
  applyTransportToMaterial,
  isTransportKind,
  transportFromMaterial,
  type AudioMaterial,
} from '../../src/index';
import { isAnalysisKind } from './analysisKinds';
import { KEYBOARD_OUTPUTS, isKeyboardKind } from './analogKeyboard';
import { catalogEntry, createMaterial, isToolEntry } from './catalog';
import { nodeInputs, nodeOutputs } from './controlInputs';
import { emptyPatch, type CratePatch, type PatchTransport } from './patch';
import { passthroughLinks, type GraphLink } from './passthrough';
import { isLineKind, isMidiClipKind, isMidiIoKind } from './tools';
import { isBformatPort } from './spatialNodes';
import { bindSocket } from './render/bindSocket';
import { PatchConnection } from './render/PatchConnection';
import { PatchNodeView } from './render/PatchNodeView';

const signalSocket = new ClassicPreset.Socket('signal');
/**
 * Four channels of ambisonics, not something you can listen to.
 *
 * A separate socket rather than a convention, so that patching a spatial
 * source into the mixer is refused at the cable rather than producing a
 * quiet, phasey stereo fold of a B-format signal, which is what the default
 * channel interpretation would give you.
 */
const bformatSocket = new ClassicPreset.Socket('bformat');

export class PatchNode extends ClassicPreset.Node {
  width = 172;
  height = 96;
  nodeData?: Record<string, unknown>;
  constructor(
    public nodeKind: string,
    label: string,
    inputs: readonly string[],
    outputs: readonly string[] = ['audio'],
  ) {
    super(label);
    for (const name of inputs) {
      const socket = isBformatPort(nodeKind, 'input', name) ? bformatSocket : signalSocket;
      this.addInput(name, new ClassicPreset.Input(socket, jackLabel(name), true));
    }
    for (const name of outputs) {
      const socket = isBformatPort(nodeKind, 'output', name) ? bformatSocket : signalSocket;
      this.addOutput(name, new ClassicPreset.Output(socket, socketLabel(nodeKind, name), true));
    }
    this.height = 36 + Math.max(inputs.length, outputs.length, 1) * 22;
    if (isKeyboardKind(nodeKind) || isMidiClipKind(nodeKind) || isMidiIoKind(nodeKind)) this.width = 188;
    if (isTransportKind(nodeKind)) this.width = 196;
    if (isAnalysisKind(nodeKind)) {
      this.width = 228;
      this.height += 48;
    }
  }
}

function jackLabel(name: string): string {
  if (name === 'input') return 'in';
  return name;
}

/**
 * A spatial source's outlet is called `audio` by the AudioMaterial, because that
 * is what the graph calls its output. Showing that on the node would invite
 * exactly the cable the socket type exists to refuse.
 */
function socketLabel(kind: string, name: string): string {
  return isBformatPort(kind, 'output', name) ? 'foa' : name;
}

type Schemes = GetSchemes<
  ClassicPreset.Node,
  ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>
>;
type AreaExtra = ReactArea2D<Schemes>;

export type EditorChangeKind = 'view' | 'graph';

export interface EditorHooks {
  onChange: (kind?: EditorChangeKind) => void;
  onSelect: (nodeId: string | null, origin?: 'user' | 'graph') => void;
}

function graphKeepsInspector(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('[data-testid="node"]') ||
      target.closest('[data-testid="connection"]') ||
      target.closest('[data-testid="input-socket"]') ||
      target.closest('[data-testid="output-socket"]'),
  );
}

export class PatchEditor {
  readonly editor: NodeEditor<Schemes>;
  readonly area: AreaPlugin<Schemes, AreaExtra>;
  readonly materials = new Map<string, AudioMaterial>();
  readonly kinds = new Map<string, string>();
  transport: PatchTransport | null = null;
  private readonly hooks: EditorHooks;
  private selected: string | null = null;
  private dropIndex = 0;
  private canvasPress: { x: number; y: number; target: EventTarget | null } | null = null;

  constructor(container: HTMLElement, hooks: EditorHooks) {
    this.hooks = hooks;
    this.editor = new NodeEditor<Schemes>();
    this.area = new AreaPlugin<Schemes, AreaExtra>(container);
    const render = new ReactPlugin<Schemes, AreaExtra>({ createRoot });
    render.addPreset(
      Presets.classic.setup({
        customize: {
          node: () => PatchNodeView as never,
          connection: () => PatchConnection as never,
          socket: (info) => bindSocket(info),
        },
      }),
    );
    const connection = new ConnectionPlugin<Schemes, AreaExtra>();
    connection.addPreset(ConnectionPresets.classic.setup());
    this.editor.use(this.area);
    this.area.use(render);
    this.area.use(connection);
    AreaExtensions.selectableNodes(this.area, AreaExtensions.selector(), {
      accumulating: AreaExtensions.accumulateOnCtrl(),
    });
    AreaExtensions.simpleNodesOrder(this.area);
    this.area.addPipe((context) => {
      if (context.type === 'nodepicked') {
        this.selected = context.data.id;
        this.hooks.onSelect(context.data.id, 'user');
      }
      if (context.type === 'pointerdown') {
        this.canvasPress = {
          x: context.data.event.clientX,
          y: context.data.event.clientY,
          target: context.data.event.target,
        };
      }
      if (context.type === 'pointerup') {
        this.releaseCanvasPress(context.data.event);
      }
      if (context.type === 'nodetranslated') {
        this.hooks.onChange('view');
      }
      if (context.type === 'connectioncreated' || context.type === 'connectionremoved') {
        this.hooks.onChange('graph');
      }
      return context;
    });
    this.editor.addPipe((context) => {
      // Rete does not check socket compatibility on its own, so this is the
      // gate. Returning undefined cancels the connection before it exists,
      // which is the difference between "the cable will not attach" and "the
      // patch is silently wrong".
      if (context.type === 'connectioncreate') {
        if (!this.socketsMatch(context.data)) return;
      }
      if (context.type === 'nodecreated' || context.type === 'noderemoved' || context.type === 'connectioncreated' || context.type === 'connectionremoved') {
        this.hooks.onChange();
      }
      return context;
    });
  }

  /**
   * True when a proposed cable joins two ports of the same signal type.
   *
   * Both directions matter: B-format into the mixer would fold four channels
   * into a phasey stereo pair, and ordinary audio into a spatial master would
   * be read as a field whose W, Y, Z and X are all the same signal, which
   * decodes to a source stuck at the front-right corner.
   */
  private socketsMatch(data: { source: string; sourceOutput: string; target: string; targetInput: string }): boolean {
    const sourceKind = this.kinds.get(data.source) ?? '';
    const targetKind = this.kinds.get(data.target) ?? '';
    const from = isBformatPort(sourceKind, 'output', data.sourceOutput);
    const to = isBformatPort(targetKind, 'input', data.targetInput);
    return from === to;
  }

  get selectedId(): string | null {
    return this.selected;
  }

  private releaseCanvasPress(event: PointerEvent): void {
    const press = this.canvasPress;
    this.canvasPress = null;
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (dx * dx + dy * dy > 64) return;
    if (graphKeepsInspector(press.target)) return;
    this.selected = null;
    this.hooks.onSelect(null);
  }

  selectedKind(): string | null {
    return this.selected ? this.kinds.get(this.selected) ?? null : null;
  }

  selectedMaterial(): AudioMaterial | null {
    return this.selected ? this.materials.get(this.selected) ?? null : null;
  }

  copiedNode(): CratePatch['nodes'][number] | null {
    if (!this.selected) return null;
    return this.getPatch().nodes.find((node) => node.id === this.selected) ?? null;
  }

  async pasteNode(
    saved: { kind: string; params: Record<string, number>; data?: Record<string, unknown>; x: number; y: number },
    position?: { x: number; y: number },
  ): Promise<string> {
    const id = await this.addKind(saved.kind, position ?? { x: saved.x + 36, y: saved.y + 36 });
    const material = this.materials.get(id);
    if (material) {
      for (const [name, value] of Object.entries(saved.params)) {
        try {
          material.setParam(name, value);
        } catch {
          /* schema drifted */
        }
      }
      if (isTransportKind(saved.kind)) this.syncTransportFromGraph();
    }
    if (saved.data) {
      const node = this.editor.getNodes().find((item) => item.id === id);
      if (node instanceof PatchNode) node.nodeData = { ...(node.nodeData ?? {}), ...saved.data };
    }
    this.hooks.onChange();
    return id;
  }

  async addKind(kind: string, position?: { x: number; y: number }): Promise<string> {
    const entry = catalogEntry(kind);
    if (!entry) throw new Error(`Unknown material kind "${kind}"`);
    let node: PatchNode;
    if (isToolEntry(entry)) {
      node = new PatchNode(entry.kind, entry.label, entry.inputs ?? [], entry.outputs ?? []);
      if (isLineKind(entry.kind)) node.nodeData = { monitor: 0 };
    } else {
      const material = entry.create!();
      if (isTransportKind(entry.kind) && this.transport) {
        applyTransportToMaterial(material, this.transport);
      }
      node = new PatchNode(entry.kind, entry.label, nodeInputs(material), nodeOutputs(material));
      this.materials.set(node.id, material);
      if (isTransportKind(entry.kind)) this.syncTransportFromGraph();
    }
    this.kinds.set(node.id, entry.kind);
    await this.editor.addNode(node);
    const at = position ?? {
      x: 80 + (this.dropIndex % 4) * 48,
      y: 80 + (this.dropIndex % 5) * 36,
    };
    this.dropIndex += 1;
    await this.area.translate(node.id, at);
    this.selected = node.id;
    this.hooks.onSelect(node.id, 'user');
    this.hooks.onChange();
    return node.id;
  }

  select(id: string): void {
    this.selected = id;
    this.hooks.onSelect(id, 'user');
  }

  graphLinks(): GraphLink[] {
    return this.editor.getConnections().map((conn) => ({
      source: conn.source,
      sourceOutput: conn.sourceOutput,
      target: conn.target,
      targetInput: conn.targetInput,
    }));
  }

  canPassthrough(id: string): boolean {
    return passthroughLinks(id, this.graphLinks()).length > 0;
  }

  async removeNode(id: string): Promise<void> {
    for (const conn of [...this.editor.getConnections()]) {
      if (conn.source === id || conn.target === id) await this.editor.removeConnection(conn.id);
    }
    await this.editor.removeNode(id);
    this.materials.delete(id);
    this.kinds.delete(id);
    if (this.selected === id) {
      this.selected = null;
      this.hooks.onSelect(null);
    }
    this.hooks.onChange();
  }

  async removeNodePassthrough(id: string): Promise<void> {
    const rewires = passthroughLinks(id, this.graphLinks());
    await this.removeNode(id);
    const byId = new Map(this.editor.getNodes().map((node) => [node.id, node]));
    for (const link of rewires) {
      const source = byId.get(link.source);
      const target = byId.get(link.target);
      if (!source || !target) continue;
      if (!source.outputs[link.sourceOutput] || !target.inputs[link.targetInput]) continue;
      await this.editor.addConnection(
        new ClassicPreset.Connection(
          source,
          link.sourceOutput as never,
          target,
          link.targetInput as never,
        ),
      );
    }
  }

  async removeSelected(): Promise<void> {
    if (!this.selected) return;
    await this.removeNode(this.selected);
  }

  async clear(): Promise<void> {
    for (const conn of [...this.editor.getConnections()]) await this.editor.removeConnection(conn.id);
    for (const node of [...this.editor.getNodes()]) await this.editor.removeNode(node.id);
    this.materials.clear();
    this.kinds.clear();
    this.transport = null;
    this.selected = null;
    this.hooks.onSelect(null);
  }

  firstTransportMaterial(): AudioMaterial | null {
    for (const [id, kind] of this.kinds) {
      if (!isTransportKind(kind)) continue;
      return this.materials.get(id) ?? null;
    }
    return null;
  }

  syncTransportFromGraph(): void {
    const material = this.firstTransportMaterial();
    if (!material) return;
    this.transport = transportFromMaterial(material, this.transport?.startSec);
  }

  getPatch(): CratePatch {
    this.syncTransportFromGraph();
    const patch = emptyPatch();
    for (const node of this.editor.getNodes()) {
      const view = this.area.nodeViews.get(node.id);
      const material = this.materials.get(node.id);
      const saved: CratePatch['nodes'][number] = {
        id: node.id,
        kind: this.kinds.get(node.id) ?? material?.kind ?? 'unknown',
        x: view?.position.x ?? 0,
        y: view?.position.y ?? 0,
        params: material?.snapshotParams() ?? {},
      };
      if (node instanceof PatchNode && node.nodeData) saved.data = node.nodeData;
      patch.nodes.push(saved);
    }
    if (this.transport) patch.transport = this.transport;
    for (const conn of this.editor.getConnections()) {
      patch.connections.push({
        source: conn.source,
        sourceOutput: conn.sourceOutput,
        target: conn.target,
        targetInput: conn.targetInput,
      });
    }
    return patch;
  }

  async loadPatch(patch: CratePatch): Promise<void> {
    await this.clear();
    const byId = new Map<string, PatchNode>();
    for (const saved of patch.nodes) {
      const entry = catalogEntry(saved.kind);
      if (!entry) continue;
      let node: PatchNode;
      if (isToolEntry(entry)) {
        node = new PatchNode(entry.kind, entry.label, entry.inputs ?? [], entry.outputs ?? (isKeyboardKind(saved.kind) ? KEYBOARD_OUTPUTS : []));
      } else {
        let material: AudioMaterial;
        try {
          material = createMaterial(saved.kind);
        } catch {
          continue;
        }
        for (const [name, value] of Object.entries(saved.params)) {
          try {
            material.setParam(name, value);
          } catch {
            /* schema drifted */
          }
        }
        node = new PatchNode(material.kind, entry.label, nodeInputs(material), nodeOutputs(material));
        this.materials.set(saved.id, material);
      }
      if (isLineKind(saved.kind)) node.nodeData = { monitor: 0, ...(saved.data ?? {}) };
      else if (saved.data) node.nodeData = saved.data;
      (node as { id: string }).id = saved.id;
      this.kinds.set(node.id, saved.kind);
      await this.editor.addNode(node);
      await this.area.translate(node.id, { x: saved.x, y: saved.y });
      byId.set(saved.id, node);
    }
    for (const conn of patch.connections) {
      const source = byId.get(conn.source);
      const target = byId.get(conn.target);
      if (!source || !target) continue;
      if (!source.outputs[conn.sourceOutput] || !target.inputs[conn.targetInput]) continue;
      await this.editor.addConnection(
        new ClassicPreset.Connection(
          source as ClassicPreset.Node,
          conn.sourceOutput as never,
          target as ClassicPreset.Node,
          conn.targetInput as never,
        ),
      );
    }
    if (patch.nodes[0]) {
      this.selected = patch.nodes[0].id;
      this.hooks.onSelect(this.selected);
    }
    this.transport = patch.transport ?? null;
    const transportNode = this.firstTransportMaterial();
    if (transportNode) {
      if (this.transport) applyTransportToMaterial(transportNode, this.transport);
      this.syncTransportFromGraph();
    }
    await AreaExtensions.zoomAt(this.area, this.editor.getNodes());
    this.hooks.onChange();
  }

  nodeData(id: string): Record<string, unknown> | undefined {
    const node = this.editor.getNodes().find((item) => item.id === id);
    return node instanceof PatchNode ? node.nodeData : undefined;
  }

  patchNodeData(id: string, patch: Record<string, unknown>): void {
    const node = this.editor.getNodes().find((item) => item.id === id);
    if (!(node instanceof PatchNode)) return;
    node.nodeData = { ...(node.nodeData ?? {}), ...patch };
  }

  graphPointFromClient(clientX: number, clientY: number): { x: number; y: number } {
    this.area.area.setPointerFrom({ clientX, clientY } as MouseEvent);
    return { x: this.area.area.pointer.x, y: this.area.area.pointer.y };
  }

  destroy(): void {
    this.area.destroy();
  }
}
