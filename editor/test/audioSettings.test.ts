import { describe, expect, it } from 'vitest';
import { latencyHintForBufferMs } from '../src/host/webAudioContext';
import {
  AUDIO_SETTINGS_KEY,
  DEFAULT_AUDIO_SETTINGS,
  loadAudioSettings,
  normalizeAudioSettings,
  saveAudioSettings,
} from '../src/audioSettings';

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    data,
  };
}

describe('audio settings', () => {
  it('maps IO pills to stable device categories instead of 2ms', () => {
    expect(latencyHintForBufferMs(2)).toBe('interactive');
    expect(latencyHintForBufferMs(10)).toBe('playback');
    expect(latencyHintForBufferMs(20)).toBe('playback');
  });

  it('keeps DAW defaults for junk values', () => {
    expect(normalizeAudioSettings({ bufferMs: 7, sampleRate: 22050, renderBlock: 32 })).toEqual(
      DEFAULT_AUDIO_SETTINGS,
    );
  });

  it('accepts the DAW pills', () => {
    expect(normalizeAudioSettings({ bufferMs: 0.5, sampleRate: 48000, renderBlock: 64 })).toEqual({
      bufferMs: 0.5,
      sampleRate: 48000,
      renderBlock: 64,
    });
  });

  it('round-trips through storage', () => {
    const store = memoryStore();
    const saved = saveAudioSettings({ bufferMs: 10, sampleRate: 44100, renderBlock: 256 }, store);
    expect(store.data[AUDIO_SETTINGS_KEY]).toContain('44100');
    expect(loadAudioSettings(store)).toEqual(saved);
  });
});
