import { OSC_WAVE_HINTS, wavePath } from './oscillatorWaves';

interface WavePickerProps {
  options: readonly string[];
  value: number;
  shape: number;
  onChange: (index: number) => void;
}

export function WavePicker({ options, value, shape, onChange }: WavePickerProps) {
  const current = Math.min(Math.max(Math.round(value), 0), options.length - 1);
  return (
    <div className="wave-picker">
      <svg className="wave-preview" viewBox="0 0 160 28" aria-hidden="true">
        <path d={wavePath(current, shape, 160, 28)} />
      </svg>
      <div className="wave-grid">
        {options.map((label, index) => (
          <button
            key={label}
            type="button"
            className={index === current ? 'on' : ''}
            title={OSC_WAVE_HINTS[index] ?? label}
            onClick={() => onChange(index)}
          >
            <svg viewBox="0 0 48 18" aria-hidden="true">
              <path d={wavePath(index, index === 4 || index === 5 || index === 6 || index === 7 ? shape : 0.5)} />
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
