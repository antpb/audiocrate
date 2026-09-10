import { NOISE_COLOR_HINTS, noiseIconPath } from './noiseColors';

interface NoisePickerProps {
  options: readonly string[];
  value: number;
  onChange: (index: number) => void;
}

export function NoisePicker({ options, value, onChange }: NoisePickerProps) {
  const current = Math.min(Math.max(Math.round(value), 0), options.length - 1);
  return (
    <div className="wave-picker">
      <svg className="wave-preview" viewBox="0 0 160 28" aria-hidden="true">
        <path d={noiseIconPath(current, 160, 28)} />
      </svg>
      <div className="wave-grid">
        {options.map((label, index) => (
          <button
            key={label}
            type="button"
            className={index === current ? 'on' : ''}
            title={NOISE_COLOR_HINTS[index] ?? label}
            onClick={() => onChange(index)}
          >
            <svg viewBox="0 0 48 18" aria-hidden="true">
              <path d={noiseIconPath(index)} />
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
