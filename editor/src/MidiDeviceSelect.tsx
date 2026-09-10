import { useCallback, useEffect, useState } from 'react';
import { listMidiPorts, requestMidiAccess, type MidiPortInfo } from '../../src/index';

interface MidiDeviceSelectProps {
  deviceId: string | null;
  direction: 'input' | 'output';
  onChange: (id: string | null) => void;
}

export function MidiDeviceSelect({ deviceId, direction, onChange }: MidiDeviceSelectProps) {
  const [ports, setPorts] = useState<MidiPortInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const access = await requestMidiAccess();
      setPorts(listMidiPorts(access).filter((port) => port.direction === direction));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [direction]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const known = ports.some((port) => port.id === deviceId);

  return (
    <label className="param">
      <span>Device</span>
      <select
        value={deviceId ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">First available</option>
        {deviceId && !known ? <option value={deviceId}>Saved device</option> : null}
        {ports.map((port) => (
          <option key={port.id} value={port.id}>
            {port.name}
          </option>
        ))}
      </select>
      {error ? <p className="asset-slot-error">{error}</p> : null}
    </label>
  );
}
