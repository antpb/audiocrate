import { useEffect, useRef } from 'react';
import type { AnalysisView as View } from './analysisBus';

interface Props {
  kind: string;
  view: View;
}

export function AnalysisView({ kind, view }: Props) {
  const showMeter = kind === 'meter' || kind === 'analyzer' || kind === 'tuner';
  const showWave = kind === 'scope' || kind === 'analyzer' || kind === 'meter' || kind === 'tuner';
  const showSpec = kind === 'analyzer' || kind === 'scope';
  const showTuner = kind === 'tuner' || kind === 'analyzer';
  const showLufs = kind === 'analyzer';
  const waveHeight = kind === 'scope' ? 96 : 64;
  return (
    <div className="analysis-view">
      {showWave ? <WaveCanvas wave={view.wave} height={waveHeight} /> : null}
      {showMeter ? <LevelMeters peak={view.peak} rms={view.rms} /> : null}
      {showSpec ? <SpectrumCanvas bins={view.spectrum} /> : null}
      {showTuner ? <TunerFace view={view} /> : null}
      {showLufs ? <p className="analysis-readout">LUFS {view.lufs.toFixed(1)}</p> : null}
    </div>
  );
}

function LevelMeters({ peak, rms }: { peak: number; rms: number }) {
  return (
    <div className="level-meters">
      <LevelBar label="peak" value={peak} />
      <LevelBar label="rms" value={rms} />
    </div>
  );
}

function LevelBar({ label, value }: { label: string; value: number }) {
  const db = value > 1e-6 ? 20 * Math.log10(value) : -60;
  const fill = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <div className="level-bar">
      <span>{label}</span>
      <div className="level-track">
        <div className="level-fill" style={{ transform: `scaleX(${fill})` }} />
      </div>
      <em>{db.toFixed(1)}</em>
    </div>
  );
}

function TunerFace({ view }: { view: View }) {
  const locked = view.hz > 0 && Number.isFinite(view.cents);
  const cents = locked ? view.cents : 0;
  const needle = Math.max(-1, Math.min(1, cents / 50));
  return (
    <div className="tuner-face">
      <div className="tuner-note">{locked ? view.note : '-'}</div>
      <div className="tuner-scale">
        <span>-50</span>
        <span>0</span>
        <span>+50</span>
        <div className="tuner-needle" style={{ left: `${50 + needle * 50}%` }} />
      </div>
      <p className="analysis-readout">
        {locked ? `${view.hz.toFixed(1)} Hz · ${cents >= 0 ? '+' : ''}${cents.toFixed(1)} c` : 'listening'}
      </p>
    </div>
  );
}

function WaveCanvas({ wave, height }: { wave: Float32Array; height: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#2e2e2e';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    if (wave.length === 0) return;
    const step = Math.max(1, Math.floor(wave.length / w));
    ctx.strokeStyle = '#c8d0b4';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let i = 0;
    for (let x = 0; x < w; x += 1) {
      let min = wave[i] ?? 0;
      let max = min;
      const end = Math.min(wave.length, i + step);
      for (let j = i; j < end; j += 1) {
        const s = wave[j] ?? 0;
        if (s < min) min = s;
        if (s > max) max = s;
      }
      i = end;
      const y1 = h / 2 - max * (h / 2 - 2);
      const y2 = h / 2 - min * (h / 2 - 2);
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
  }, [wave, height]);
  return <canvas ref={ref} className="analysis-canvas" width={240} height={height} />;
}

function SpectrumCanvas({ bins }: { bins: Float32Array }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, w, h);
    if (bins.length === 0) return;
    let max = 1e-6;
    for (let i = 0; i < bins.length; i += 1) if ((bins[i] ?? 0) > max) max = bins[i]!;
    const gap = 1;
    const bar = Math.max(1, (w - (bins.length - 1) * gap) / bins.length);
    ctx.fillStyle = '#8a8a70';
    for (let i = 0; i < bins.length; i += 1) {
      const n = Math.max(0, Math.min(1, (bins[i] ?? 0) / max));
      const bh = n * (h - 2);
      ctx.fillRect(i * (bar + gap), h - bh, bar, bh);
    }
  }, [bins]);
  return <canvas ref={ref} className="analysis-canvas" width={240} height={56} />;
}
