/**
 * Fetching a portable kernel's bytes, once.
 *
 * The other half of the distribution problem is mundane and still has to be
 * solved: something has to get a `.wasm` file from a package onto the main
 * thread so `VoiceHandle.loadKernel` can post it into the worklet realm,
 * which can neither fetch nor import.
 *
 * Audiocrate's existing answer is `KernelBinaryMap`, a map the *host* fills. That
 * is right for an application's own plugins, where the host already knows
 * what it ships and when to load it. It is wrong for a third-party Material:
 * it would mean installing a package and then also editing host code to
 * fetch its binary, which is most of the barrier the portable kernel format
 * exists to remove.
 *
 * So a plugin may instead fetch its own, from a URL it resolves relative to
 * its own module:
 *
 * ```ts
 * async bindLiveVoice(voice, material) {
 *   const binary = await fetchKernelBinary(new URL('./tape.wasm', import.meta.url).href);
 *   await voice.loadKernel(TAPE_SLOT, { binary, descriptor, params: material.snapshotParams() });
 * }
 * ```
 *
 * The cache is the reason this exists rather than a bare `fetch`. A live
 * scene calls `bindLiveVoice` once per voice, so a sixteen-track project with
 * the same plugin on every track would otherwise pull the same multi-megabyte
 * module sixteen times. In-flight requests are shared too, since those voices
 * are prepared in the same turn and would otherwise all miss the cache
 * together.
 */

const cache = new Map<string, Promise<ArrayBuffer>>();

export interface FetchKernelBinaryOptions {
  /** Injectable for tests and non-browser hosts, matching the rest of the package. */
  fetchImpl?: typeof fetch;
  /** Skips the cache and replaces the entry. For a plugin hot-swapping its own build. */
  reload?: boolean;
}

/**
 * Reads a kernel binary, sharing one request per URL. Rejects rather than
 * resolving empty on a failed response, so `loadKernel` fails loudly instead
 * of a plugin loading a kernel made of nothing.
 */
export function fetchKernelBinary(url: string, options: FetchKernelBinaryOptions = {}): Promise<ArrayBuffer> {
  if (options.reload) cache.delete(url);
  const existing = cache.get(url);
  if (existing) return existing;

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (!doFetch) {
    return Promise.reject(new Error('fetchKernelBinary: no fetch in this environment; pass fetchImpl'));
  }

  const pending = doFetch(url)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`fetchKernelBinary: ${url} responded ${response.status}`);
      }
      return response.arrayBuffer();
    })
    .catch((err: unknown) => {
      // A failed fetch must not poison the cache: a transient network error
      // would otherwise make the plugin permanently broken for the session.
      cache.delete(url);
      throw err;
    });

  cache.set(url, pending);
  return pending;
}

/** Drops cached binaries. Tests, and a host tearing down between projects. */
export function clearKernelBinaryCache(): void {
  cache.clear();
}
