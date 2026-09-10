import { useMemo } from 'react';

function fitWave(wave: Float32Array, points: number): Float32Array {
  if (wave.length <= points) return wave;
  const out = new Float32Array(points);
  const step = wave.length / points;
  for (let i = 0; i < points; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let min = wave[start] ?? 0;
    let max = min;
    for (let j = start; j < end; j += 1) {
      const s = wave[j] ?? 0;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    out[i] = Math.abs(max) > Math.abs(min) ? max : min;
  }
  return out;
}

export function MiniScope({ wave }: { wave: Float32Array }) {
  const d = useMemo(() => {
    const w = 48;
    const h = 14;
    const drawn = fitWave(wave, 48);
    if (drawn.length === 0) return `M0 ${h / 2} H${w}`;
    let min = drawn[0] ?? 0;
    let max = min;
    for (let i = 1; i < drawn.length; i += 1) {
      const sample = drawn[i] ?? 0;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    const unipolar = min >= -0.02 && max <= 1.02 && max > 0.02;
    const parts: string[] = [];
    for (let i = 0; i < drawn.length; i += 1) {
      const x = (i / Math.max(1, drawn.length - 1)) * w;
      const sample = drawn[i] ?? 0;
      const y = unipolar
        ? h - 1 - Math.max(0, Math.min(1, sample)) * (h - 2)
        : h / 2 - sample * (h / 2 - 1);
      parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return parts.join(' ');
  }, [wave]);
  return (
    <svg className="mini-scope" width="48" height="14" viewBox="0 0 48 14" aria-hidden>
      <path d={d} />
    </svg>
  );
}
