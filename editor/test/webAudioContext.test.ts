import { describe, expect, it } from 'vitest';
import {
  attachNodeToHtmlSink,
  audioContextOptionsForDevice,
  htmlPlaybackRateForStream,
  latencyHintForBufferMs,
  prefersHtmlAudioSink,
  shouldConnectWebAudioDestination,
} from '../src/host/webAudioContext';

describe('prefersHtmlAudioSink', () => {
  it('is true for iPhone Safari', () => {
    expect(
      prefersHtmlAudioSink(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        5,
        'iPhone',
      ),
    ).toBe(true);
  });

  it('is false for a desktop Mac', () => {
    expect(prefersHtmlAudioSink('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, 'MacIntel')).toBe(false);
  });
});

describe('audioContextOptionsForDevice', () => {
  it('opens iOS at 44.1 kHz playback so the HTML stream rate matches', () => {
    expect(audioContextOptionsForDevice({ sampleRate: null, bufferMs: 2 }, true)).toEqual({
      latencyHint: 'playback',
      sampleRate: 44100,
    });
  });

  it('honors an explicit rate and still uses playback on iOS', () => {
    expect(audioContextOptionsForDevice({ sampleRate: 48000, bufferMs: 0.5 }, true)).toEqual({
      latencyHint: 'playback',
      sampleRate: 48000,
    });
  });

  it('maps a desktop song buffer to playback, not a tight callback', () => {
    expect(audioContextOptionsForDevice({ sampleRate: null, bufferMs: 10 }, false)).toEqual({
      latencyHint: 'playback',
    });
    expect(latencyHintForBufferMs(10)).toBe('playback');
  });
});

describe('htmlPlaybackRateForStream', () => {
  it('speeds a 44.1k stream on a 48k context back to wall clock', () => {
    expect(htmlPlaybackRateForStream(48000, 44100)).toBeCloseTo(48000 / 44100, 8);
  });

  it('is unity when the rates match', () => {
    expect(htmlPlaybackRateForStream(44100, 44100)).toBe(1);
  });
});

describe('speaker output', () => {
  it('always keeps AudioContext.destination', () => {
    expect(shouldConnectWebAudioDestination(false, false)).toBe(true);
    expect(shouldConnectWebAudioDestination(true, true)).toBe(true);
  });

  it('connects destination and never disconnects it', () => {
    const connected: unknown[] = [];
    const node = {
      connect: (dest: AudioNode) => {
        connected.push(dest);
      },
      disconnect: () => {
        throw new Error('destination must stay connected');
      },
    };
    const destination = {} as AudioNode;
    expect(() => attachNodeToHtmlSink(node, destination)).not.toThrow();
    expect(connected).toEqual([destination]);
  });
});
