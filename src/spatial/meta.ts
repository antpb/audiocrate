import type { NamedSpatialPosition, SpatialPositionName } from './positions';

/**
 * Sidecar / udta payload (embedded `spatialPosition` JSON or `.spatial.json`).
 */
export interface SpatialMetaEntry {
  trackIndex: number;
  spatialPosition: SpatialPositionName | string;
  volume?: number;
}

export function parseSpatialMeta(json: unknown): SpatialMetaEntry[] | null {
  if (typeof json === 'string') {
    try {
      return parseSpatialMeta(JSON.parse(json));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(json)) return null;
  const out: SpatialMetaEntry[] = [];
  for (const row of json) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    if (rec.spatialPosition == null) continue;
    const trackIndex = Number(rec.trackIndex ?? 0);
    out.push({
      trackIndex: Number.isFinite(trackIndex) ? trackIndex : 0,
      spatialPosition: String(rec.spatialPosition),
      ...(typeof rec.volume === 'number' ? { volume: rec.volume } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

export function buildSpatialMeta(
  sources: Array<{ trackIndex?: number; named: SpatialPositionName | null; volume?: number }>,
): SpatialMetaEntry[] {
  return sources.map((source, i) => ({
    trackIndex: source.trackIndex ?? i,
    spatialPosition: source.named ?? 'center',
    ...(source.volume != null ? { volume: source.volume } : {}),
  }));
}

export function isGlobalMeta(entry: SpatialMetaEntry): boolean {
  return entry.spatialPosition === 'global';
}

export type { NamedSpatialPosition };
