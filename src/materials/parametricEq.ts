import { AudioMaterial } from '../graph/AudioMaterial';
import { param } from '../graph/param';
import { filter, select } from '../asl/builders';
import type { ASLValue, ASLValueLike } from '../asl/ASLValue';

export const EQ_BAND_TYPES = ['Shelf', 'Peak'] as const;

function peakOrShelf(
  input: ASLValue,
  type: ASLValueLike,
  freq: ASLValueLike,
  gainDb: ASLValueLike,
  q: ASLValueLike,
  shelf: 'low' | 'high',
): ASLValue {
  const peak = filter.peaking(input, { freq, gainDb, q });
  const shaped =
    shelf === 'low'
      ? filter.lowshelf(input, { freq, gainDb, q })
      : filter.highshelf(input, { freq, gainDb, q });
  return select(shaped, peak, { which: type });
}

/**
 * A 4-band channel EQ: highpass, low (shelf or peak), two mid bells,
 * high (shelf or peak), lowpass. Gains at 0 dB are exact bypass. The
 * filters default off so an unused node does not color the signal.
 */
export const parametricEqMaterial = new AudioMaterial({
  name: 'ParametricEQ',
  kind: 'ParametricEQ',
  params: {
    hpOn: param.toggle({ default: false, label: 'Highpass' }),
    hpFreq: param.range(20, 2000, { default: 80, unit: 'Hz', curve: 'log', label: 'HP Freq' }),
    hpQ: param.range(0.3, 2, { default: 0.707, label: 'HP Q' }),

    lowType: param.enum(EQ_BAND_TYPES, { default: 'Shelf', label: 'Low Type' }),
    lowFreq: param.range(20, 500, { default: 100, unit: 'Hz', curve: 'log', label: 'Low Freq' }),
    lowGain: param.range(-18, 18, { default: 0, unit: 'dB', label: 'Low Gain' }),
    lowQ: param.range(0.3, 2, { default: 0.7, label: 'Low Q' }),

    lowMidFreq: param.range(80, 2000, { default: 400, unit: 'Hz', curve: 'log', label: 'Low Mid Freq' }),
    lowMidGain: param.range(-18, 18, { default: 0, unit: 'dB', label: 'Low Mid Gain' }),
    lowMidQ: param.range(0.1, 10, { default: 1, label: 'Low Mid Q' }),

    highMidFreq: param.range(400, 8000, { default: 2500, unit: 'Hz', curve: 'log', label: 'High Mid Freq' }),
    highMidGain: param.range(-18, 18, { default: 0, unit: 'dB', label: 'High Mid Gain' }),
    highMidQ: param.range(0.1, 10, { default: 1, label: 'High Mid Q' }),

    highType: param.enum(EQ_BAND_TYPES, { default: 'Shelf', label: 'High Type' }),
    highFreq: param.range(2000, 20000, { default: 8000, unit: 'Hz', curve: 'log', label: 'High Freq' }),
    highGain: param.range(-18, 18, { default: 0, unit: 'dB', label: 'High Gain' }),
    highQ: param.range(0.3, 2, { default: 0.7, label: 'High Q' }),

    lpOn: param.toggle({ default: false, label: 'Lowpass' }),
    lpFreq: param.range(1000, 20000, { default: 12000, unit: 'Hz', curve: 'log', label: 'LP Freq' }),
    lpQ: param.range(0.3, 2, { default: 0.707, label: 'LP Q' }),
  },
  automatable: [
    'hpFreq',
    'lowFreq',
    'lowGain',
    'lowMidFreq',
    'lowMidGain',
    'highMidFreq',
    'highMidGain',
    'highGain',
    'lpFreq',
  ],
  graph: ({ input, params }) => {
    const highpassed = filter.highpass(input, { cutoff: params.hpFreq, q: params.hpQ });
    const afterHp = select(input, highpassed, { which: params.hpOn });
    const low = peakOrShelf(afterHp, params.lowType, params.lowFreq, params.lowGain, params.lowQ, 'low');
    const lowMid = filter.peaking(low, {
      freq: params.lowMidFreq,
      gainDb: params.lowMidGain,
      q: params.lowMidQ,
    });
    const highMid = filter.peaking(lowMid, {
      freq: params.highMidFreq,
      gainDb: params.highMidGain,
      q: params.highMidQ,
    });
    const high = peakOrShelf(highMid, params.highType, params.highFreq, params.highGain, params.highQ, 'high');
    const lowpassed = filter.lowpass(high, { cutoff: params.lpFreq, q: params.lpQ });
    return select(high, lowpassed, { which: params.lpOn });
  },
});
