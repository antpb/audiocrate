export const OSC_WAVE_HINTS = [
  'Sine',
  'Saw',
  'Square',
  'Triangle',
  'Pulse width',
  'Triangle to saw to square',
  'Hard-synced slave, 1x to 4x',
  'Harmonic tilt, mellow to bright',
] as const;

export function shapeLabelForWave(type: number): string | null {
  switch (type) {
    case 4:
      return 'Width';
    case 5:
      return 'Morph';
    case 6:
      return 'Sync';
    case 7:
      return 'Tilt';
    default:
      return null;
  }
}

export function previewOscSample(type: number, phase: number, shape = 0.5): number {
  switch (type) {
    case 1:
      return 2 * phase - 1;
    case 2:
      return phase < 0.5 ? 1 : -1;
    case 3:
      return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    case 4: {
      const duty = Math.min(Math.max(shape, 1e-4), 1 - 1e-4);
      return phase < duty ? 1 : -1;
    }
    case 5: {
      const t = shape < 0 ? 0 : shape > 1 ? 1 : shape;
      const tri = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
      const saw = 2 * phase - 1;
      const square = phase < 0.5 ? 1 : -1;
      if (t < 0.5) {
        const mix = t * 2;
        return tri * (1 - mix) + saw * mix;
      }
      const mix = (t - 0.5) * 2;
      return saw * (1 - mix) + square * mix;
    }
    case 6: {
      const ratio = 1 + (shape < 0 ? 0 : shape > 1 ? 1 : shape) * 3;
      const slave = (phase * ratio) % 1;
      return ((2 * phase - 1) + (slave < 0.5 ? 1 : -1)) * 0.5;
    }
    case 7: {
      const tilt = shape < 0 ? 0 : shape > 1 ? 1 : shape;
      const exponent = 2 * (1 - tilt);
      let norm = 0;
      let sample = 0;
      for (let h = 0; h < 8; h++) {
        const n = h + 1;
        const amp = 1 / n ** exponent;
        norm += amp;
        sample += amp * Math.sin(2 * Math.PI * phase * n);
      }
      return norm > 0 ? sample / norm : 0;
    }
    default:
      return Math.sin(2 * Math.PI * phase);
  }
}

export function wavePath(type: number, shape = 0.5, width = 48, height = 18): string {
  const steps = 48;
  const mid = height / 2;
  const amp = mid - 1;
  const parts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const phase = i / (steps - 1);
    const y = mid - previewOscSample(type, phase, shape) * amp;
    const x = (i / (steps - 1)) * width;
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return parts.join(' ');
}
