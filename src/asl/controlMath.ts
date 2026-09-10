export const QUANTIZE_SCALE_NAMES = ['major', 'minor', 'pentatonic', 'chromatic', 'wholeTone'] as const;

/**
 * Semitone sets for `quantize`, same order as `QUANTIZE_SCALE_NAMES`.
 * These are the live subset of `theory/scales.ts` SCALE_INTERVALS:
 * major, minor, pentatonicMajor (named pentatonic here), chromatic, wholeTone.
 * Dorian, blues, and the rest exist in theory only; this node cannot select them.
 */
export const QUANTIZE_SCALES = [
  [0, 2, 4, 5, 7, 9, 11],
  [0, 2, 3, 5, 7, 8, 10],
  [0, 2, 4, 7, 9],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [0, 2, 4, 6, 8, 10],
] as const;

export function quantizeToScale(note: number, root: number, scaleIndex: number): number {
  const degrees = QUANTIZE_SCALES[Math.min(Math.max(Math.round(scaleIndex), 0), QUANTIZE_SCALES.length - 1)]!;
  const shifted = note - root;
  const octave = Math.floor(shifted / 12);
  const pc = shifted - octave * 12;
  let bestDeg: number = degrees[0] ?? 0;
  let bestDist = Infinity;
  for (const degree of degrees) {
    for (const candidate of [degree, degree - 12, degree + 12]) {
      const dist = Math.abs(candidate - pc);
      if (dist < bestDist - 1e-12) {
        bestDist = dist;
        bestDeg = candidate;
      }
    }
  }
  return root + octave * 12 + bestDeg;
}

export function euclideanPattern(steps: number, hits: number, rotation: number): boolean[] {
  const n = Math.max(1, Math.floor(steps));
  const k = Math.min(n, Math.max(0, Math.floor(hits)));
  const pattern: boolean[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += k;
    if (acc >= n) {
      acc -= n;
      pattern.push(true);
    } else {
      pattern.push(false);
    }
  }
  const rot = ((Math.floor(rotation) % n) + n) % n;
  if (rot === 0) return pattern;
  return pattern.slice(rot).concat(pattern.slice(0, rot));
}
