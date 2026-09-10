/**
 * The capability probe, against fakes shaped like the runtimes crate is
 * actually asked to run on.
 *
 * The version numbers below are not decoration: they are the reason this
 * module exists. `react-native-audio-api` went from no worklet and no
 * convolver at 0.8 to worklets, a convolver and a delay at 0.13, and still
 * has no `PannerNode`. A host that assumes "Web Audio" means the browser's
 * Web Audio gets an undefined property at the first note.
 */
import { describe, expect, it } from 'vitest';
import {
  crateFeatureSupport,
  describeCrateSupport,
  probeAudioCapabilities,
} from '../../src/host/audioCapabilities';

/** Everything a current browser has. */
const browserContext = {
  audioWorklet: { addModule: async () => {} },
  createPanner: () => {},
  createChannelSplitter: () => {},
  createChannelMerger: () => {},
  createConvolver: () => {},
  createDelay: () => {},
  createConstantSource: () => {},
  createStereoPanner: () => {},
  createAnalyser: () => {},
};

/** react-native-audio-api 0.8: the version the Android port is pinned to. */
const rnAudioApi08 = {
  createGain: () => {},
  createOscillator: () => {},
  createBiquadFilter: () => {},
  createStereoPanner: () => {},
  createAnalyser: () => {},
  createBufferSource: () => {},
};

/** react-native-audio-api 0.13: worklets and a convolver, still no panner. */
const rnAudioApi013 = {
  ...rnAudioApi08,
  createWorkletProcessingNode: () => {},
  createWorkletNode: () => {},
  createConvolver: () => {},
  createDelay: () => {},
  createConstantSource: () => {},
  createWaveShaper: () => {},
};

describe('probeAudioCapabilities', () => {
  it('reports everything on a browser context', () => {
    const caps = probeAudioCapabilities(browserContext);
    expect(caps.audioWorklet).toBe(true);
    expect(caps.panner).toBe(true);
    expect(caps.channelSplitter).toBe(true);
    expect(caps.convolver).toBe(true);
  });

  it('reports what react-native-audio-api 0.8 is missing', () => {
    const caps = probeAudioCapabilities(rnAudioApi08);
    expect(caps.audioWorklet).toBe(false);
    expect(caps.workletCallback).toBe(false);
    expect(caps.panner).toBe(false);
    expect(caps.convolver).toBe(false);
    expect(caps.stereoPanner).toBe(true);
  });

  it('sees 0.13 gained an audio-thread callback but still has no panner', () => {
    const caps = probeAudioCapabilities(rnAudioApi013);
    expect(caps.workletCallback).toBe(true);
    expect(caps.audioWorklet).toBe(false);
    expect(caps.convolver).toBe(true);
    expect(caps.delay).toBe(true);
    expect(caps.panner).toBe(false);
  });

  it('survives null, undefined and nonsense without throwing', () => {
    // A probe that throws on a missing context is worse than useless: it
    // fails in exactly the situation it was added to diagnose.
    for (const value of [null, undefined, 42, 'ctx', {}]) {
      const caps = probeAudioCapabilities(value);
      expect(caps.audioWorklet).toBe(false);
      expect(caps.panner).toBe(false);
    }
  });

  it('does not construct anything while probing', () => {
    // Constructing a node can claim a device or start a render thread, which
    // a capability check has no business doing.
    let constructed = 0;
    const spy = {
      audioWorklet: { addModule: async () => {} },
      createPanner: () => {
        constructed += 1;
      },
      createChannelSplitter: () => {
        constructed += 1;
      },
    };
    probeAudioCapabilities(spy);
    expect(constructed).toBe(0);
  });
});

describe('crateFeatureSupport', () => {
  it('gives a browser everything, with nothing to explain', () => {
    const support = crateFeatureSupport(probeAudioCapabilities(browserContext));
    expect(support.realtimeVoices).toBe(true);
    expect(support.spatialBinaural).toBe(true);
    expect(support.spatialRouting).toBe(true);
    expect(support.notes).toEqual([]);
  });

  it('offline rendering is available everywhere, including on nothing', () => {
    // The property the whole degradation story rests on.
    expect(crateFeatureSupport(probeAudioCapabilities(null)).offlineRender).toBe(true);
    expect(crateFeatureSupport(probeAudioCapabilities(browserContext)).offlineRender).toBe(true);
  });

  it('tells a 0.8 host to render offline and play a buffer', () => {
    const support = crateFeatureSupport(probeAudioCapabilities(rnAudioApi08));
    expect(support.realtimeVoices).toBe(false);
    expect(support.spatialRouting).toBe(false);
    expect(support.notes.join(' ')).toMatch(/OfflineRenderer/);
  });

  it('tells a 0.13 host to drive compileVoice from its callback node', () => {
    // The actionable difference between the two versions, and the reason the
    // probe distinguishes `audioWorklet` from `workletCallback` at all.
    const support = crateFeatureSupport(probeAudioCapabilities(rnAudioApi013));
    expect(support.realtimeVoices).toBe(false);
    expect(support.notes.join(' ')).toMatch(/compileVoice/);
    expect(support.notes.join(' ')).not.toMatch(/OfflineRenderer/);
  });

  it('separates routing from decoding, so a field can be built without a panner', () => {
    // A runtime with a splitter and no panner can still sum and rotate
    // B-format and export it correctly. Collapsing the two would report
    // "no spatial" and throw away a working ambisonic path.
    const support = crateFeatureSupport({
      ...probeAudioCapabilities(browserContext),
      panner: false,
    });
    expect(support.spatialRouting).toBe(true);
    expect(support.spatialBinaural).toBe(false);
    expect(support.notes.join(' ')).toMatch(/decode: 'stereo'/);
  });

  it('does not suggest a stereo decode when routing is unavailable too', () => {
    // Advice for a fallback the host cannot reach either would be noise.
    const support = crateFeatureSupport(probeAudioCapabilities(rnAudioApi08));
    expect(support.notes.join(' ')).not.toMatch(/decode: 'stereo'/);
  });
});

describe('describeCrateSupport', () => {
  it('returns the capabilities alongside the verdict', () => {
    const described = describeCrateSupport(rnAudioApi013);
    expect(described.capabilities.workletCallback).toBe(true);
    expect(described.realtimeVoices).toBe(false);
    expect(described.offlineRender).toBe(true);
  });
});
