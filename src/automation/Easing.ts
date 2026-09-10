/**
 * Each maps normalized progress u in 0..1 to 0..1.
 */

export type EasingFn = (u: number) => number;

function clamp01(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u;
}

export const Easing = {
  linear: (u: number) => clamp01(u),
  exp: (u: number) => Math.pow(clamp01(u), 2.5),
  log: (u: number) => 1 - Math.pow(1 - clamp01(u), 2.5),
  sCurve: (u: number) => {
    const t = clamp01(u);
    return t * t * (3 - 2 * t);
  },
  swell: (u: number) => Math.sin(Math.PI * clamp01(u)),
} as const satisfies Record<string, EasingFn>;

export type EasingName = keyof typeof Easing;
