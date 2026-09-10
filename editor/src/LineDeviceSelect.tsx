import { useCallback, useEffect, useState } from 'react';
import { listLineInputs, type AudioInputPort } from './lineInput';

interface LineDeviceSelectProps {
  deviceId: string | null;
  onChange: (id: string | null) => Promise<void>;
}

export function LineDeviceSelect({ deviceId, onChange }: LineDeviceSelectProps) {
  const [ports, setPorts] = useState<AudioInputPort[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPorts(await listLineInputs());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    if (!md || typeof md.addEventListener !== 'function') return;
    md.addEventListener('devicechange', refresh);
    return () => md.removeEventListener('devicechange', refresh);
  }, [refresh]);

  const known = ports.some((port) => port.uid === deviceId);

  return (
    <label className="param">
      <span>Input</span>
      <select
        value={deviceId ?? ''}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value || null;
          setBusy(true);
          setError(null);
          void onChange(next)
            .then(() => refresh())
            .catch((err) => {
              setError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setBusy(false));
        }}
      >
        <option value="">System default</option>
        {deviceId && !known ? <option value={deviceId}>Saved input</option> : null}
        {ports.map((port) => (
          <option key={port.uid} value={port.uid}>
            {port.name}
          </option>
        ))}
      </select>
      {error ? <p className="asset-slot-error">{error}</p> : null}
    </label>
  );
}
