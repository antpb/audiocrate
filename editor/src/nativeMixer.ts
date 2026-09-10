/**
 * Gain and StereoPan as native Web Audio nodes, so a full mix does not
 * spawn a worklet per fader.
 */

export function stereoPanGains(pan: number): { keep: number; fold: number; lawL: number; lawR: number } {
  const p = Math.min(1, Math.max(-1, Number.isFinite(pan) ? pan : 0));
  const mag = Math.abs(p);
  const angle = ((p + 1) * Math.PI) / 4;
  return {
    keep: 1 - mag * 0.5,
    fold: mag * 0.5,
    lawL: Math.SQRT2 * Math.cos(angle),
    lawR: Math.SQRT2 * Math.sin(angle),
  };
}

export interface NativeLive {
  input: AudioNode;
  mix: GainNode;
  setParam: (name: string, value: number) => void;
}

export function createNativeGain(ctx: AudioContext, gain: number): NativeLive {
  const mix = ctx.createGain();
  mix.gain.value = Number.isFinite(gain) ? gain : 1;
  return {
    input: mix,
    mix,
    setParam: (name, value) => {
      if (name === 'gain' && Number.isFinite(value)) mix.gain.value = value;
    },
  };
}

export function createNativeStereoPan(ctx: AudioContext, pan: number): NativeLive {
  const input = ctx.createGain();
  input.gain.value = 1;
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  const split = ctx.createChannelSplitter(2);
  input.connect(split);
  const keepL = ctx.createGain();
  const foldL = ctx.createGain();
  const keepR = ctx.createGain();
  const foldR = ctx.createGain();
  const lawL = ctx.createGain();
  const lawR = ctx.createGain();
  split.connect(keepL, 0);
  split.connect(foldR, 0);
  split.connect(foldL, 1);
  split.connect(keepR, 1);
  const sumL = ctx.createGain();
  const sumR = ctx.createGain();
  keepL.connect(sumL);
  foldL.connect(sumL);
  keepR.connect(sumR);
  foldR.connect(sumR);
  sumL.connect(lawL);
  sumR.connect(lawR);
  const merge = ctx.createChannelMerger(2);
  lawL.connect(merge, 0, 0);
  lawR.connect(merge, 0, 1);
  const mix = ctx.createGain();
  mix.gain.value = 1;
  merge.connect(mix);

  const apply = (value: number) => {
    const gains = stereoPanGains(value);
    keepL.gain.value = gains.keep;
    keepR.gain.value = gains.keep;
    foldL.gain.value = gains.fold;
    foldR.gain.value = gains.fold;
    lawL.gain.value = gains.lawL;
    lawR.gain.value = gains.lawR;
  };
  apply(pan);

  return {
    input,
    mix,
    setParam: (name, value) => {
      if (name === 'pan') apply(value);
    },
  };
}
