export const AUDIO_SETTINGS_KEY = 'crate.patcher.audio';

export const BUFFER_MS_OPTIONS = [0.5, 1, 2, 3, 5, 10, 20] as const;
export const SAMPLE_RATE_OPTIONS = [44100, 48000, 96000] as const;
export const RENDER_BLOCK_OPTIONS = [
  { label: 'Auto', frames: 0 },
  { label: '256', frames: 256 },
  { label: '128', frames: 128 },
  { label: '64', frames: 64 },
] as const;

export interface AudioSettings {
  /** Preferred output latency, same pills as the DAW IO buffer. */
  bufferMs: number;
  /** Null is the device default. */
  sampleRate: number | null;
  /** 0 is Auto (256 frames for NAM). */
  renderBlock: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  bufferMs: 10,
  sampleRate: null,
  renderBlock: 0,
};

export function normalizeAudioSettings(value: Partial<AudioSettings> | null | undefined): AudioSettings {
  const bufferMs = Number(value?.bufferMs);
  const sampleRate = value?.sampleRate == null ? null : Number(value.sampleRate);
  const renderBlock = Number(value?.renderBlock);
  return {
    bufferMs: (BUFFER_MS_OPTIONS as readonly number[]).includes(bufferMs) ? bufferMs : DEFAULT_AUDIO_SETTINGS.bufferMs,
    sampleRate: sampleRate != null && (SAMPLE_RATE_OPTIONS as readonly number[]).includes(sampleRate) ? sampleRate : null,
    renderBlock: renderBlock === 64 || renderBlock === 128 || renderBlock === 256 ? renderBlock : 0,
  };
}

export function loadAudioSettings(store: Pick<Storage, 'getItem'> = localStorage): AudioSettings {
  try {
    const raw = store.getItem(AUDIO_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_SETTINGS };
    return normalizeAudioSettings(JSON.parse(raw) as Partial<AudioSettings>);
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export function saveAudioSettings(
  settings: AudioSettings,
  store: Pick<Storage, 'setItem'> = localStorage,
): AudioSettings {
  const next = normalizeAudioSettings(settings);
  store.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(next));
  return next;
}
