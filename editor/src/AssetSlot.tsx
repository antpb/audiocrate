import { useRef, useState } from 'react';

interface AssetSlotProps {
  label: string;
  filename: string | null;
  accept: string;
  factoryLabel?: string;
  onChoose: (file: File) => Promise<void>;
  onFactory?: () => Promise<void>;
  onClear: () => void;
}

export function AssetSlot({
  label,
  filename,
  accept,
  factoryLabel,
  onChoose,
  onFactory,
  onClear,
}: AssetSlotProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="asset-slot">
      <span>
        {label}
        <em>{filename ?? 'none'}</em>
      </span>
      <div className="asset-slot-actions">
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          Choose
        </button>
        {onFactory ? (
          <button type="button" disabled={busy} onClick={() => void run(onFactory)}>
            {factoryLabel ?? 'Factory'}
          </button>
        ) : null}
        {filename ? (
          <button type="button" disabled={busy} onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      {error ? <p className="asset-slot-error">{error}</p> : null}
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void run(() => onChoose(file));
        }}
      />
    </div>
  );
}
