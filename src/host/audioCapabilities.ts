/**
 * What a given Web Audio implementation can actually do, and which parts of
 * crate that leaves working.
 *
 * ## Why this exists
 *
 * "Web Audio" is not one thing. A browser has the whole spec. React Native
 * has `react-native-audio-api`, which implements a growing subset: as of
 * 0.8 it had no worklet, no `PannerNode`, no `ConvolverNode` and no
 * `DelayNode`; by 0.13 it had worklets, a convolver and a delay, and still no
 * `PannerNode`. An Electron page, an old Safari and a WebView are each
 * somewhere else again.
 *
 * Crate degrades cleanly across all of that, but only if the host knows what
 * it is standing on. Without this, a React Native app calling
 * `new WebAudioRenderer(ctx)` gets `Cannot read property 'addModule' of
 * undefined` at the first note, which names nothing useful.
 *
 * ## The offline path always works
 *
 * `OfflineRenderer` runs the same interpreter with no `AudioContext` at all,
 * so rendering an AudioMaterial to samples is available on every runtime including
 * ones with no audio output. That is why `offlineRender` is not a probe
 * result: it is a constant, and saying so is the point.
 */

/** Node types crate reaches for, as found on a candidate context. */
export interface AudioCapabilities {
  /** `ctx.audioWorklet.addModule`: the spec's worklet, what `WebAudioRenderer` needs. */
  audioWorklet: boolean;
  /**
   * A block callback on the audio thread under another name.
   * `react-native-audio-api` spells this `createWorkletProcessingNode`, and it
   * takes a function rather than a module URL, so the same interpreter can run
   * behind it without any of the URL and bundling machinery a browser needs.
   */
  workletCallback: boolean;
  /** `PannerNode` with HRTF, which is where `SpatialBus` gets binaural from. */
  panner: boolean;
  channelSplitter: boolean;
  channelMerger: boolean;
  convolver: boolean;
  delay: boolean;
  constantSource: boolean;
  stereoPanner: boolean;
  analyser: boolean;
}

export interface CrateFeatureSupport {
  /** `WebAudioRenderer`: one worklet voice per AudioMaterial. */
  realtimeVoices: boolean;
  /** `SpatialBus` with `decode: 'binaural'`. */
  spatialBinaural: boolean;
  /** `SpatialBus` with `decode: 'stereo'` or `'ambisonic'`. */
  spatialRouting: boolean;
  /** `OfflineRenderer`. Always true: it needs no context at all. */
  offlineRender: true;
  /** One line per unavailable feature, saying what is missing and what to do. */
  notes: string[];
}

function has(context: unknown, method: string): boolean {
  return typeof (context as Record<string, unknown>)?.[method] === 'function';
}

/**
 * Inspects a context without constructing anything.
 *
 * Feature-detects by looking for the factory methods rather than by
 * `try { new PannerNode() } catch`, because on some implementations
 * constructing a node has side effects (claiming an audio device, starting a
 * render thread) that a capability check has no business causing.
 */
export function probeAudioCapabilities(context: unknown): AudioCapabilities {
  const ctx = context as Record<string, unknown> | null | undefined;
  const worklet = ctx?.audioWorklet as { addModule?: unknown } | undefined;
  return {
    audioWorklet: typeof worklet?.addModule === 'function',
    workletCallback:
      has(ctx, 'createWorkletProcessingNode') || has(ctx, 'createWorkletNode'),
    panner: has(ctx, 'createPanner'),
    channelSplitter: has(ctx, 'createChannelSplitter'),
    channelMerger: has(ctx, 'createChannelMerger'),
    convolver: has(ctx, 'createConvolver'),
    delay: has(ctx, 'createDelay'),
    constantSource: has(ctx, 'createConstantSource'),
    stereoPanner: has(ctx, 'createStereoPanner'),
    analyser: has(ctx, 'createAnalyser'),
  };
}

/**
 * Turns capabilities into "which parts of crate work here", with reasons.
 *
 * The reasons are the useful half. A host that cannot do binaural should be
 * able to tell its user why and what it fell back to, rather than sounding
 * quietly flat and leaving them to wonder whether the mix is wrong.
 */
export function crateFeatureSupport(capabilities: AudioCapabilities): CrateFeatureSupport {
  const notes: string[] = [];

  const realtimeVoices = capabilities.audioWorklet;
  if (!realtimeVoices) {
    notes.push(
      capabilities.workletCallback
        ? 'No AudioWorklet, but this runtime has an audio-thread callback node. ' +
          'WebAudioRenderer cannot be used; drive `compileVoice` from that callback instead.'
        : 'No AudioWorklet and no audio-thread callback. Real-time voices are unavailable; ' +
          'render with OfflineRenderer and play the result from a buffer source.',
    );
  }

  // The rotation is nine gains around a splitter and a merger; the decode is
  // what needs panners. So a runtime can route and rotate a field it cannot
  // binaurally decode, which is worth separating because the ambisonic output
  // is still correct and still exportable.
  const spatialRouting = capabilities.channelSplitter && capabilities.channelMerger;
  if (!spatialRouting) {
    notes.push(
      'No channel splitter or merger, so SpatialBus cannot route B-format. ' +
        'Spatial mixing is offline only here, through encodeAmbisonics.',
    );
  }

  const spatialBinaural = spatialRouting && capabilities.panner;
  if (spatialRouting && !capabilities.panner) {
    notes.push(
      'No PannerNode, so there is no head-related filtering to decode through. ' +
        "Use SpatialBus with decode: 'stereo', which is the same pan law an " +
        'exported fallback track uses.',
    );
  }

  return { realtimeVoices, spatialBinaural, spatialRouting, offlineRender: true, notes };
}

/** Probe and interpret in one call, for a host that just wants the answer. */
export function describeCrateSupport(context: unknown): CrateFeatureSupport & {
  capabilities: AudioCapabilities;
} {
  const capabilities = probeAudioCapabilities(context);
  return { ...crateFeatureSupport(capabilities), capabilities };
}
