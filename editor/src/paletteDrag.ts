export const PALETTE_KIND_MIME = 'application/x-crate-kind';

export function writePaletteKind(transfer: DataTransfer, kind: string): void {
  transfer.setData(PALETTE_KIND_MIME, kind);
  transfer.setData('text/plain', kind);
  transfer.effectAllowed = 'copy';
}

export function readPaletteKind(transfer: DataTransfer | null): string | null {
  if (!transfer) return null;
  const typed = transfer.getData(PALETTE_KIND_MIME).trim();
  if (typed) return typed;
  const plain = transfer.getData('text/plain').trim();
  return plain || null;
}

export function isPaletteDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = [...transfer.types];
  return types.includes(PALETTE_KIND_MIME) || types.includes('text/plain');
}

/** Same conversion rete uses: holder-local pixels, then divide by zoom. */
export function graphPointFromHolder(
  holder: Pick<Element, 'getBoundingClientRect'>,
  zoom: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = holder.getBoundingClientRect();
  const k = zoom || 1;
  return {
    x: (clientX - rect.left) / k,
    y: (clientY - rect.top) / k,
  };
}
