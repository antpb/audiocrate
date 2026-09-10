import { noteName } from '../../src/index';
import type { AnalogSnapshot } from './analogKeyboard';

export function VoiceStrip({ snapshot }: { snapshot: AnalogSnapshot }) {
  const held = snapshot.lamps.filter((lamp) => lamp.held && lamp.note != null);
  const poly = snapshot.polyphony > 1;
  return (
    <div className="voices">
      <span className="voices-meta">
        {poly ? `poly ${held.length}/${snapshot.polyphony}` : 'mono'}
        {poly ? ` · ${snapshot.steal}` : ' · last note'}
        {snapshot.targetName ? ` · ${snapshot.targetName}` : ''}
      </span>
      <span className="voices-notes">
        {held.length > 0 ? held.map((lamp) => noteName(lamp.note!)).join(' ') : 'idle'}
      </span>
      <span className="voices-lamps" aria-hidden>
        {snapshot.lamps.map((lamp) => (
          <i key={lamp.index} className={lamp.held ? 'on' : ''} title={lamp.note != null ? noteName(lamp.note) : 'idle'} />
        ))}
      </span>
    </div>
  );
}
