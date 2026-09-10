import type { ReactNode } from 'react';
import { denormalizeParam, type InspectorControl } from '../../src/index';
import { RangeSlider } from './RangeSlider';

export function InspectorControlRow({
  control,
  onParam,
  label,
}: {
  control: InspectorControl;
  onParam: (name: string, value: number) => void;
  label?: string;
}) {
  const title = label ?? control.label;
  if (control.kind === 'switch') {
    return (
      <label className="param row">
        <span>{title}</span>
        <input
          type="checkbox"
          checked={control.value >= 0.5}
          onChange={(event) => onParam(control.name, event.target.checked ? 1 : 0)}
        />
      </label>
    );
  }
  if (control.kind === 'menu' && control.options) {
    return (
      <label className="param">
        <span>{title}</span>
        <select
          value={Math.round(control.value)}
          onChange={(event) => onParam(control.name, Number(event.target.value))}
        >
          {control.options.map((option, index) => (
            <option key={option} value={index}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="param">
      <span>
        {title}
        <em>{control.display}</em>
      </span>
      <RangeSlider
        min={0}
        max={1}
        step={0.001}
        value={control.normalized}
        onChange={(event) =>
          onParam(control.name, denormalizeParam(control.descriptor, Number(event.target.value)))
        }
      />
    </label>
  );
}

export function ControlGroups({
  groups,
  controls,
  onParam,
  hint,
  renderControl,
}: {
  groups: readonly { title: string; names: readonly string[] }[];
  controls: readonly InspectorControl[];
  onParam: (name: string, value: number) => void;
  hint?: string;
  renderControl?: (control: InspectorControl) => ReactNode | undefined;
}) {
  const byName = new Map(controls.map((control) => [control.name, control]));
  return (
    <div className="eq-bands">
      {hint ? <p className="hint">{hint}</p> : null}
      {groups.map((group) => (
        <section key={group.title} className="eq-band">
          <h3>{group.title}</h3>
          {group.names.map((name) => {
            const control = byName.get(name);
            if (!control) return null;
            const custom = renderControl?.(control);
            if (custom !== undefined) return <div key={name}>{custom}</div>;
            return <InspectorControlRow key={name} control={control} onParam={onParam} />;
          })}
        </section>
      ))}
    </div>
  );
}
