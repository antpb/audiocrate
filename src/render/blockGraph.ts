/**
 * The live voice processor, run without Web Audio.
 *
 * Rendering ahead of the playhead (in a Worker, on another core) has to
 * produce exactly what live playback would: the same processor, the same
 * kernels, the same sample-accurate MIDI, the same idling. So this does not
 * re-implement any of it. It captures the processor class a worklet bundle
 * registers (`captureVoiceProcessor`), and `BlockGraph` drives instances of
 * it block by block: ports are delivered in-process, connections are summed
 * the way Web Audio sums them, and the clock is the graph's own.
 *
 * `BlockGraph` is a `LiveVoiceRenderer`, so `prepareLiveVoices`, every
 * plugin's `bindLiveVoice` (kernel loading included), `connectSplitVoices`
 * and `scheduledPoolTarget` run on it unchanged.
 */
import type { ASLGraphDescriptor } from '../asl/graph';
import { auxAudioPorts } from '../asl/ports';
import type { TransportAnchor } from '../asl/transportNodes';
import type { AnalysisMessage, VoiceHandle } from '../renderers/WebAudioRenderer';

type Message = { data: unknown };

interface ProcessorPort {
  onmessage: ((event: Message) => void) | null;
  postMessage(message: unknown): void;
}

interface VoiceProcessor {
  port: ProcessorPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

export type VoiceProcessorClass = new (options?: { processorOptions?: unknown }) => VoiceProcessor;

const LISTENERS = Symbol('audiocrate.blockPortListeners');
type HostPort = ProcessorPort & { [LISTENERS]: Set<(message: unknown) => void> };

function hostPort(): HostPort {
  const listeners = new Set<(message: unknown) => void>();
  return {
    onmessage: null,
    postMessage(message: unknown) {
      for (const listener of listeners) listener(message);
    },
    [LISTENERS]: listeners,
  };
}

const CAPTURED = Symbol.for('audiocrate.capturedVoiceProcessors');

/**
 * Loads a worklet bundle into this realm (a Worker, or a test) and returns
 * the voice processor class it registered. `load` imports the bundle, e.g.
 * `() => import(workletUrl)`. The audio-worklet globals the bundle expects
 * are provided first; `sampleRate` is the rate every processor will see.
 * Once per realm: a second call returns the class the first one captured.
 */
export async function captureVoiceProcessor(
  load: () => Promise<unknown>,
  options: { sampleRate: number; name?: string },
): Promise<VoiceProcessorClass> {
  const scope = globalThis as unknown as Record<string | symbol, unknown>;
  const name = options.name ?? 'crate-voice-processor';
  let classes = scope[CAPTURED] as Map<string, VoiceProcessorClass> | undefined;
  if (!classes) {
    classes = new Map();
    scope[CAPTURED] = classes;
    scope.sampleRate = options.sampleRate;
    scope.currentTime = 0;
    if (!scope.AudioWorkletProcessor) {
      scope.AudioWorkletProcessor = class {
        port: ProcessorPort = hostPort();
      };
    }
    const registered = classes;
    scope.registerProcessor = (processorName: string, ctor: VoiceProcessorClass) => {
      registered.set(processorName, ctor);
    };
    await load();
  }
  const ctor = classes.get(name);
  if (!ctor) throw new Error(`audiocrate: the worklet bundle registered no "${name}" processor`);
  return ctor;
}

interface Edge {
  node: BlockNode;
  output: number;
}

/** One processor in the graph. Shaped like enough of an AudioWorkletNode for live voices. */
export class BlockNode {
  readonly sources: Edge[][];
  readonly outputs: Float32Array[][];
  alive = true;
  readonly port: {
    postMessage(message: unknown): void;
    addEventListener(type: 'message', listener: (event: Message) => void): void;
    removeEventListener(type: 'message', listener: (event: Message) => void): void;
    start(): void;
  };

  constructor(
    private readonly graph: BlockGraph,
    readonly processor: VoiceProcessor | null,
    inputs: number,
    outputs: number,
  ) {
    this.sources = Array.from({ length: inputs }, () => []);
    this.outputs = Array.from({ length: outputs }, () => [
      new Float32Array(graph.blockSize),
      new Float32Array(graph.blockSize),
    ]);
    const wrapped = new Map<(event: Message) => void, (message: unknown) => void>();
    const listeners = (processor?.port as HostPort | undefined)?.[LISTENERS];
    this.port = {
      postMessage: (message) => {
        // A processor reads the realm's one `currentTime` to decide whether a
        // timed message is already due. Several graphs share a realm (a
        // worker renders several tracks), so it must read this graph's clock,
        // not wherever the last graph to render left it.
        graph.syncClock();
        processor?.port.onmessage?.({ data: message });
      },
      addEventListener: (_type, listener) => {
        const fn = (message: unknown) => listener({ data: message });
        wrapped.set(listener, fn);
        listeners?.add(fn);
      },
      removeEventListener: (_type, listener) => {
        const fn = wrapped.get(listener);
        if (fn) listeners?.delete(fn);
        wrapped.delete(listener);
      },
      start: () => {},
    };
  }

  connect(destination: BlockNode, output = 0, input = 0): BlockNode {
    destination.sources[input]!.push({ node: this, output });
    this.graph.invalidate();
    return destination;
  }

  /** Removes every connection out of this node. */
  disconnect(): void {
    for (const node of this.graph.nodes) {
      for (const edges of node.sources) {
        for (let i = edges.length - 1; i >= 0; i--) if (edges[i]!.node === this) edges.splice(i, 1);
      }
    }
    this.graph.invalidate();
  }
}

/**
 * A graph of voice processors rendered block by block, with `output` as its
 * one sink. `time` is the graph's clock in seconds, the `currentTime` every
 * processor reads and every timed message is in.
 */
export class BlockGraph {
  readonly nodes: BlockNode[] = [];
  readonly output: BlockNode;
  time = 0;
  private order: BlockNode[] | null = null;
  private readonly silence: Float32Array;
  private readonly mixScratch = new Map<BlockNode, Float32Array[][]>();

  constructor(
    private readonly Processor: VoiceProcessorClass,
    readonly sampleRate: number,
    readonly blockSize = 128,
  ) {
    this.silence = new Float32Array(blockSize);
    this.output = new BlockNode(this, null, 1, 1);
  }

  invalidate(): void {
    this.order = null;
  }

  /** Points the realm's audio-worklet clock at this graph. */
  syncClock(): void {
    const scope = globalThis as unknown as Record<string, unknown>;
    scope.currentTime = this.time;
    scope.sampleRate = this.sampleRate;
  }

  /** Same contract as `WebAudioRenderer.createVoice`. */
  async createVoice(
    graph: ASLGraphDescriptor,
    options: { seed?: number; params?: Record<string, number>; sends?: boolean } = {},
  ): Promise<VoiceHandle> {
    const auxInputs = auxAudioPorts(graph);
    const sendOutputs = options.sends && graph.sends ? graph.sends.length : 1;
    this.syncClock();
    const processor = new this.Processor({
      processorOptions: {
        graph,
        seed: options.seed ?? Math.floor(Math.random() * 4294967296),
        ...(options.params ? { params: options.params } : {}),
        ...(options.sends && graph.sends ? { sends: true } : {}),
      },
    });
    const node = new BlockNode(this, processor, 1 + auxInputs.length, sendOutputs);
    this.nodes.push(node);
    this.invalidate();
    const post = (message: unknown) => node.port.postMessage(message);

    const waitForKernel = (slot: string) =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (event: Message) => {
          const data = event.data as { type?: string; slot?: string; message?: string };
          if (data?.slot !== slot) return;
          if (data.type === 'kernelReady') {
            node.port.removeEventListener('message', onMessage);
            resolve();
          } else if (data.type === 'kernelError') {
            node.port.removeEventListener('message', onMessage);
            reject(new Error(data.message ?? `kernel "${slot}" failed`));
          }
        };
        node.port.addEventListener('message', onMessage);
      });

    const handle = {
      node,
      auxInputs,
      inputIndexFor: (name: string) => {
        if (name === 'input') return 0;
        const index = auxInputs.indexOf(name);
        if (index === -1) throw new RangeError(`voice has no audio input "${name}"`);
        return index + 1;
      },
      noteOn: (params: Record<string, number>, when?: number) =>
        post(when === undefined ? { type: 'noteOn', params } : { type: 'noteOn', params, when }),
      noteOff: (when?: number) => post(when === undefined ? { type: 'noteOff' } : { type: 'noteOff', when }),
      setParam: (name: string, value: number) => post({ type: 'setParam', name, value }),
      loadKernel: (slot: string, payload: unknown) => {
        const ready = waitForKernel(slot);
        post({ type: 'loadKernel', slot, payload });
        return ready;
      },
      sendKernel: (slot: string, message: unknown) => post({ type: 'kernelMessage', slot, message }),
      midiNoteOn: (note: number, velocity: number, when?: number) => post({ type: 'midiNoteOn', note, velocity, when }),
      midiNoteOff: (note: number, when?: number) => post({ type: 'midiNoteOff', note, when }),
      midiControlChange: (cc: number, value: number, when?: number) => post({ type: 'midiControlChange', cc, value, when }),
      allNotesOff: () => post({ type: 'allNotesOff' }),
      setHostBpm: (bpm: number) => post({ type: 'setHostBpm', bpm }),
      setTransport: (anchor: TransportAnchor) => post({ type: 'setTransport', anchor }),
      setAnalysisInterval: (hz: number) => post({ type: 'setAnalysisInterval', hz }),
      onAnalysis: (listener: (frame: AnalysisMessage) => void) => {
        const onMessage = (event: Message) => {
          if ((event.data as { type?: string })?.type === 'analysis') listener(event.data as AnalysisMessage);
        };
        node.port.addEventListener('message', onMessage);
        return () => node.port.removeEventListener('message', onMessage);
      },
    };
    return handle as unknown as VoiceHandle;
  }

  /** Every node that reaches the output, sources before the nodes they feed. */
  private renderOrder(): BlockNode[] {
    if (this.order) return this.order;
    const order: BlockNode[] = [];
    const state = new Map<BlockNode, 1 | 2>();
    const visit = (node: BlockNode) => {
      const seen = state.get(node);
      if (seen === 2) return;
      if (seen === 1) throw new Error('audiocrate: a block graph has a cycle');
      state.set(node, 1);
      for (const edges of node.sources) for (const edge of edges) visit(edge.node);
      state.set(node, 2);
      order.push(node);
    };
    visit(this.output);
    this.order = order;
    return order;
  }

  private mixInputs(node: BlockNode): Float32Array[][] {
    let scratch = this.mixScratch.get(node);
    if (!scratch) {
      scratch = node.sources.map(() => [new Float32Array(this.blockSize), new Float32Array(this.blockSize)]);
      this.mixScratch.set(node, scratch);
    }
    return node.sources.map((edges, index) => {
      // Input 0 always has two channels, as the silent driver gives it live;
      // an unconnected port input has none, as Web Audio gives it.
      if (edges.length === 0) return index === 0 ? [this.silence, this.silence] : [];
      const [l, r] = scratch![index]!;
      l!.fill(0);
      r!.fill(0);
      for (const edge of edges) {
        const [sl, sr] = edge.node.outputs[edge.output]!;
        for (let i = 0; i < this.blockSize; i++) {
          l![i]! += sl![i]!;
          r![i]! += sr![i]!;
        }
      }
      return [l!, r!];
    });
  }

  /** Renders one block and returns the output's two channels (valid until the next call). */
  renderBlock(): [Float32Array, Float32Array] {
    this.syncClock();
    for (const node of this.renderOrder()) {
      if (node === this.output) continue;
      const inputs = this.mixInputs(node);
      for (const channels of node.outputs) for (const channel of channels) channel.fill(0);
      if (node.alive && node.processor) node.alive = node.processor.process(inputs, node.outputs);
    }
    const [l, r] = this.mixInputs(this.output)[0]!;
    this.time += this.blockSize / this.sampleRate;
    return [l!, r!];
  }
}
