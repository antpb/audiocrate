/**
 * The extension seam for DSP that cannot be expressed as ASL nodes.
 *
 * ASL describes per-sample math: oscillators, envelopes, biquads. Some DSP
 * is not that shape. A neural amp model runs a whole block through an
 * inference engine. A granular engine owns its own voice allocation and
 * produces a block from nothing. A partitioned-FFT convolver needs a block
 * to convolve. Expressing those as per-sample ASL nodes is the wrong shape.
 *
 * So a Material's graph may name a **kernel slot**, and a host binds a
 * `KernelProcessor` into that slot. Crate core defines the contract and
 * nothing else: it does not know what a NAM or a grain engine is, the same
 * way three.js core knows `ShaderMaterial` without knowing any particular
 * shader.
 *
 * Two shapes, matching the two things real kernels actually do:
 *
 *  - **seam** (`kernel.seam(slot, input)`): sits inside an otherwise ASL
 *    graph. Everything upstream is collected into a block, the kernel
 *    transforms it, and everything downstream reads the result. This is how
 *    an amp puts neural inference between its tone stack and its output
 *    gain without either side leaving ASL.
 *  - **source** (`kernel.source(slot, input?)`): *is* the whole graph. The
 *    compiled voice hands it the input block and it fills the output block.
 *    Instruments and self-contained effect engines are this.
 *
 * Every method is optional. A kernel that only implements `processSeam` is a
 * complete kernel. A slot with nothing bound is a passthrough, not silence:
 * a Material whose asset failed to load still runs the rest of its graph.
 */

/**
 * One bound DSP unit. Implementations live in plugin packages, never in
 * crate core, and run inside whichever realm the renderer chose (the
 * AudioWorklet's isolated global for `WebAudioRenderer`, the main thread for
 * `OfflineRenderer`).
 */
export interface KernelProcessor {
  /**
   * Receives the voice's current param values once per block, before
   * processing. Params are the Material's declared schema (`graph/param.ts`),
   * so a kernel reads whichever ones it cares about by name.
   */
  applyParams?(params: Record<string, number>): void;

  /**
   * Seam kernels. `input` and `output` may be the same array; an
   * implementation that cannot work in place must use its own scratch.
   */
  processSeam?(input: Float32Array, output: Float32Array): void;

  /**
   * Seam kernels, single-sample path. Used by `renderSample` (tests,
   * `OfflineRenderer`'s per-sample mode). Omit it and the seam is a
   * passthrough per-sample, which is the fallback for a kernel that
   * needs a block.
   */
  processSeamSample?(input: number): number;

  /**
   * Source kernels. `inputL` is never null (the caller supplies a zero-filled
   * block when nothing is connected), so an effect-shaped source kernel does
   * not have to null-check its own signal. `outputR` is null on a mono
   * destination; a stereo kernel should still fill `outputL`.
   */
  processSource?(
    inputL: Float32Array,
    inputR: Float32Array | null,
    outputL: Float32Array,
    outputR: Float32Array | null,
  ): void;

  noteOn?(note: number, velocity: number): void;
  noteOff?(note: number): void;
  allNotesOff?(): void;

  /**
   * MIDI control change. `params` is the live voice's own param record, passed
   * in so a kernel may map a CC onto a *graph* param (a synth's mod wheel
   * moving `lfo1Depth`) rather than only onto its own internal state. Mutating
   * it is the supported way to do that.
   */
  controlChange?(cc: number, value: number, params: Record<string, number>): void;

  setHostBpm?(bpm: number): void;

  /**
   * Slot-specific messages from the main thread (`VoiceHandle.sendKernel`).
   * This is the escape hatch for anything that is not a param: loading an
   * impulse response, swapping a sample, asking for reported latency.
   */
  onMessage?(message: unknown): unknown;

  /**
   * Measurements to include in the next analysis frame (`asl/analysis.ts`),
   * or undefined for nothing to report. Called only while a host has asked
   * for analysis, at that host's interval, never per block.
   *
   * Keep it to reading state a kernel already keeps. Analysis that needs real
   * work belongs on the main thread, from a `tap.capture` window: the audio
   * thread is the one place that must not run an FFT because a UI asked for
   * a picture.
   */
  poll?(): unknown;

  /** Extra latency this kernel introduces, in samples, for plugin delay compensation. */
  latencySamples?(): number;

  /**
   * Whatever this kernel wants the host to know once it is running, returned
   * on the ready acknowledgement. Crate does not interpret it.
   *
   * This exists because "the kernel loaded" and "the kernel loaded the thing
   * you wanted" are different claims. An amp reporting which inference
   * architecture it actually instantiated is the difference between a check
   * that proves the fast path is live and one that only proves nothing threw.
   */
  describe?(): unknown;

  dispose?(): void;
}

/** Slot name to bound processor, as a compiled voice sees it. */
export type KernelBindings = Map<string, KernelProcessor>;

/**
 * Builds the processor for one slot. Runs inside the renderer's realm, so
 * anything it needs from outside (a WASM binary, a model's JSON) has to
 * arrive through `payload`: an AudioWorklet cannot `fetch`, cannot
 * `import()`, and has no `URL`.
 */
export type KernelFactory = (
  sampleRate: number,
  payload: unknown,
) => Promise<KernelProcessor> | KernelProcessor;

/**
 * The set of kernels a renderer build knows how to create, keyed by slot.
 *
 * This is resolved at **build** time, not runtime, and that is a
 * constraint: an AudioWorklet module cannot
 * dynamically import code, so the worklet bundle has to already contain
 * every kernel it might be asked for. A host that wants extra kernels
 * composes its own worklet entry (see `defineCrateVoiceProcessor`) and points
 * `WebAudioRenderer` at it. Audiocrate's own shipped worklet has none.
 */
export type KernelFactoryMap = Record<string, KernelFactory>;

/**
 * WASM binaries (or any other bulk payload) a host has fetched, keyed by
 * kernel slot. Passed through `prepareLiveVoices` and the bake path so a
 * plugin's own binding code can pull out the one it needs without crate core
 * naming any of them.
 */
export type KernelBinaryMap = Record<string, ArrayBuffer | undefined>;
