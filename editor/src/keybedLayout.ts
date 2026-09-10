/** Two octaves on a desk. One octave on a phone, Oct +/- to move. */
export function displayedOctaves(width: number): number {
  return width <= 800 ? 1 : 2;
}

export const WHITE_DEGREES = [0, 2, 4, 5, 7, 9, 11] as const;

export function whiteKeys(startMidi: number, octaves: number): number[] {
  const whites: number[] = [];
  for (let octave = 0; octave < octaves; octave += 1) {
    for (const degree of WHITE_DEGREES) whites.push(startMidi + octave * 12 + degree);
  }
  whites.push(startMidi + octaves * 12);
  return whites;
}
