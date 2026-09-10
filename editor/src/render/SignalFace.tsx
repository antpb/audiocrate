import { MiniScope } from './MiniScope';
import type { AnalysisView } from '../analysisBus';

interface Props {
  view: AnalysisView;
  wave: Float32Array;
  peak: number;
  kind: string;
}

export function SignalFace({ view, wave, peak, kind }: Props) {
  const locked = kind === 'tuner' || kind === 'analyzer' ? view.hz > 0 : false;
  return (
    <div className="signal-face">
      <MiniScope wave={view.wave.length > 0 ? view.wave : wave} />
      <span className="pmeter" style={{ transform: `scaleY(${Math.max(peak, view.peak)})` }} />
      {locked ? (
        <span className="signal-tune">
          {view.note} {view.cents >= 0 ? '+' : ''}
          {view.cents.toFixed(0)}
        </span>
      ) : null}
    </div>
  );
}
