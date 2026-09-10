/**
 * Materials that treat left and right as separate signals rather than one
 * mono lane copied twice.
 *
 * Every one of these was impossible until an ASL graph could ask which
 * channel it was on (`audio.lane()`) and read a fixed side regardless
 * (`audio.left()` / `audio.right()`, `asl/ports.ts`). They are all one
 * expression: mid/side, width, swap and balance are not
 * eight new DSP algorithms, they are eight ways of arranging two numbers.
 * These exist because they are common mixer vocabulary.
 *
 * `channelSplit` is missing on purpose. A Material has one output, so
 * splitting a stereo pair into two independently-routed signals is a graph
 * shape, not a node. `monoLeft` / `monoRight` cover the half of it that fits
 * an insert: take one side and drop the other.
 */
import { Material } from '../graph/Material';
import { param } from '../graph/param';
import { audio, delay, lfo, panLaw, rectify, select, uniform } from '../asl/builders';
import type { ASLValueLike } from '../asl/ASLValue';

/** +1 on the left lane, -1 on the right. The sign that turns M/S into L/R. */
const laneSign = () => uniform(1).add(audio.lane().mul(-2));

export const monoSumMaterial = new Material({
  name: 'MonoSum',
  kind: 'monosum',
  params: {},
  // Sum, not average of one side: a correlated stereo pair summed at 0.5 is
  // the same level it started at, which is what a mono fold-down check wants.
  graph: ({ audio: a }) => a.left().add(a.right()).mul(0.5),
});

export const monoLeftMaterial = new Material({
  name: 'MonoLeft',
  kind: 'monoleft',
  params: {},
  graph: ({ audio: a }) => a.left().mul(1),
});

export const monoRightMaterial = new Material({
  name: 'MonoRight',
  kind: 'monoright',
  params: {},
  graph: ({ audio: a }) => a.right().mul(1),
});

export const channelSwapMaterial = new Material({
  name: 'ChannelSwap',
  kind: 'swap',
  params: {},
  // Lane 0 emits the right channel and lane 1 emits the left.
  graph: ({ audio: a }) => select(a.right(), a.left(), { which: a.lane() }),
});

/**
 * Mid/side width. 0 collapses to mono, 1 is unity, above 1 widens. The side
 * component is what gets scaled; the mid is untouched, so a width change
 * never moves the centre.
 */
export const stereoWidthMaterial = new Material({
  name: 'StereoWidth',
  kind: 'width',
  params: {
    width: param.range(0, 2, { default: 1 }),
  },
  automatable: ['width'],
  graph: ({ audio: a, params }) => {
    const mid = a.left().add(a.right()).mul(0.5);
    const side = a.left().add(a.right().mul(-1)).mul(0.5).mul(params.width);
    return mid.add(side.mul(laneSign()));
  },
});

/** Left carries mid, right carries side. Feed the result to `midSideDecode`. */
export const midSideEncodeMaterial = new Material({
  name: 'MidSideEncode',
  kind: 'midside',
  params: {},
  graph: ({ audio: a }) => {
    const mid = a.left().add(a.right()).mul(0.5);
    const side = a.left().add(a.right().mul(-1)).mul(0.5);
    return select(mid, side, { which: a.lane() });
  },
});

/** The inverse: a mid/side pair back to left/right. */
export const midSideDecodeMaterial = new Material({
  name: 'MidSideDecode',
  kind: 'midsidedecode',
  params: {},
  graph: ({ audio: a }) => a.left().add(a.right().mul(laneSign())),
});

/**
 * Independent trim on each side, in linear gain. Balance, unlike pan, does
 * not move a signal across the image; it turns one side down.
 */
export const balanceMaterial = new Material({
  name: 'Balance',
  kind: 'balance',
  params: {
    left: param.range(0, 2, { default: 1 }),
    right: param.range(0, 2, { default: 1 }),
  },
  automatable: ['left', 'right'],
  graph: ({ input, audio: a, params }) => input.mul(select(params.left, params.right, { which: a.lane() })),
});

/**
 * The recorder track-pan matrix: collapse toward the middle, then equal-power
 * position. `panLaw(input)` on the current lane is a balance control, so a
 * left-only guitar or sample went silent when panned right. Identity at
 * center, opposite-side content folds in, hard pan is the mono average at
 * +3 dB.
 */
function stereoPanMatrix(pan: ASLValueLike) {
  const mag = rectify(pan);
  const keep = uniform(1).add(mag.mul(-0.5));
  const fold = mag.mul(0.5);
  const leftMix = audio.left().mul(keep).add(audio.right().mul(fold));
  const rightMix = audio.left().mul(fold).add(audio.right().mul(keep));
  const collapsed = select(leftMix, rightMix, { which: audio.lane() });
  const gain = select(
    panLaw(uniform(Math.SQRT2), { pan, channel: 'left' }),
    panLaw(uniform(Math.SQRT2), { pan, channel: 'right' }),
    { which: audio.lane() },
  );
  return collapsed.mul(gain);
}

export const stereoPanMaterial = new Material({
  name: 'StereoPan',
  kind: 'stereopan',
  channels: 2,
  params: {
    pan: param.range(-1, 1, { default: 0 }),
  },
  automatable: ['pan'],
  graph: ({ params }) => stereoPanMatrix(params.pan),
});

/** Pan swept by an LFO. `depth` 1 sweeps hard left to hard right. */
export const autoPanMaterial = new Material({
  name: 'AutoPan',
  kind: 'autopan',
  channels: 2,
  params: {
    rate: param.range(0.01, 20, { default: 1, unit: 'Hz', curve: 'log' }),
    depth: param.range(0, 1, { default: 1 }),
  },
  automatable: ['rate', 'depth'],
  graph: ({ params }) => {
    const pan = lfo({ rate: params.rate, shape: 'sine' }).mul(params.depth);
    return stereoPanMatrix(pan);
  },
});

/**
 * Haas widening: one side delayed by a few milliseconds. Above roughly 30 ms
 * it stops widening and starts being an echo, which is why the range stops
 * where it does.
 */
export const haasMaterial = new Material({
  name: 'Haas',
  kind: 'haas',
  params: {
    delayMs: param.range(0, 30, { default: 12, unit: 'ms', curve: 'exp' }),
  },
  automatable: ['delayMs'],
  graph: ({ input, audio: a, params }) =>
    select(
      input,
      delay(input, { timeSec: params.delayMs.mul(0.001), feedback: 0, mix: 1, maxTimeSec: 0.05 }),
      { which: a.lane() },
    ),
});

/**
 * Two mono signals into one stereo pair: the insert input becomes the left
 * channel, the `sidechain` port becomes the right. This is the merge half of
 * the splitter/merger pair, and the reason a second audio input had to exist.
 */
export function createStereoMergeMaterial(): Material {
  return new Material({
    name: 'StereoMerge',
    kind: 'stereomerge',
    params: {},
    graph: ({ input, audio: a }) => select(input, a.sidechain(), { which: a.lane() }),
  });
}

// A factory as well as an instance, unlike its neighbours here: this one
// carries per-instance routing (`setAudioSource`), so two merges pulling
// from two different tracks have to be two Materials.
export const stereoMergeMaterial = createStereoMergeMaterial();

export const stereoMaterials = [
  monoSumMaterial,
  monoLeftMaterial,
  monoRightMaterial,
  channelSwapMaterial,
  stereoWidthMaterial,
  midSideEncodeMaterial,
  midSideDecodeMaterial,
  balanceMaterial,
  stereoPanMaterial,
  autoPanMaterial,
  haasMaterial,
  stereoMergeMaterial,
] as const;
