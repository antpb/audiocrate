import type { InspectorControl } from '../../src/index';
import { ControlGroups } from './ControlGroups';

interface ParametricEqPanelProps {
  controls: readonly InspectorControl[];
  onParam: (name: string, value: number) => void;
}

const BANDS: { title: string; names: readonly string[] }[] = [
  { title: 'Highpass', names: ['hpOn', 'hpFreq', 'hpQ'] },
  { title: 'Low', names: ['lowType', 'lowFreq', 'lowGain', 'lowQ'] },
  { title: 'Low Mid', names: ['lowMidFreq', 'lowMidGain', 'lowMidQ'] },
  { title: 'High Mid', names: ['highMidFreq', 'highMidGain', 'highMidQ'] },
  { title: 'High', names: ['highType', 'highFreq', 'highGain', 'highQ'] },
  { title: 'Lowpass', names: ['lpOn', 'lpFreq', 'lpQ'] },
];

export function ParametricEqPanel({ controls, onParam }: ParametricEqPanelProps) {
  return (
    <ControlGroups
      groups={BANDS}
      controls={controls}
      onParam={onParam}
      hint="Four parametric bands plus HP/LP. Low and high can be a shelf or a bell. Filters stay off until armed."
    />
  );
}
