/** Encode a byte slice as base64. Matches the world-API chunk clients. */
export function bytesToBase64(bytes: Uint8Array): string {
  const Buf = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (Buf) return Buf.from(bytes).toString('base64');
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function sliceChunks(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const size = chunkSize > 0 ? chunkSize : bytes.length || 1;
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  if (out.length === 0) out.push(new Uint8Array());
  return out;
}
