export const NOISE_COLOR_HINTS = [
  'Flat spectrum. Hiss, air, raw.',
  'Natural 1/f. Rain, tape, crowd.',
  'Rumble. Thunder, low wind.',
  'Bright, icy. More top than white.',
  'Sparkle. Extra high end.',
  'Mid-weighted. Even to the ear.',
] as const;

function hashNoise(seed: number): () => number {
  let s = (seed * 1103515245 + 12345) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

export function noiseIconPath(type: number, width = 48, height = 18): string {
  const next = hashNoise(type + 1);
  const mid = height / 2;
  const amp = mid - 1;
  let y = 0;
  let brown = 0;
  const parts: string[] = [];
  const steps = 48;
  for (let i = 0; i < steps; i++) {
    const white = next();
    brown = (brown + white * 0.08) * 0.96;
    if (type === 1) y = y * 0.86 + white * 0.25;
    else if (type === 2) y = brown;
    else if (type === 3) y = white - y * 0.35;
    else if (type === 4) y = white * 1.1 - (i > 0 ? y : 0);
    else if (type === 5) y = y * 0.7 + white * 0.2 + brown * 0.15;
    else y = white;
    const x = (i / (steps - 1)) * width;
    const py = mid - Math.min(1, Math.max(-1, y)) * amp;
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${py.toFixed(1)}`);
  }
  return parts.join(' ');
}
