/**
 * Is the checked-in worklet bundle current, and is it actually loadable?
 *
 * `bundled.generated.ts` is a build artifact living in source control, which
 * makes it the exact kind of file that can quietly describe the previous
 * version of the code. That failure mode is nasty: every unit test still
 * passes, because they exercise `asl/compile.ts` directly, while the audio a
 * browser actually renders comes from a stale copy of the same interpreter.
 * The symptom is "my DSP fix did nothing", and there is no obvious place to
 * look, because the source is correct.
 *
 * So the bundle is rebuilt here and compared byte for byte. A red test is a
 * cheap price for never debugging that.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { bundleWorklet, renderGeneratedModule, GENERATED_TS } from '../../../scripts/build-worklet.mjs';
import { CRATE_WORKLET_SOURCE, crateWorkletUrls } from '../../../src/renderers/worklet/workletUrls';

describe('the bundled worklet', () => {
  it('matches what the current sources bundle to', async () => {
    const fresh = renderGeneratedModule(await bundleWorklet());
    const onDisk = await readFile(GENERATED_TS, 'utf8');
    expect(
      onDisk === fresh,
      'src/renderers/worklet/bundled.generated.ts is stale. Run `npm run build:worklet`.',
    ).toBe(true);
  }, 30_000);

  it('registers the processor crate asks for by default', () => {
    // The renderer defaults to the name 'crate-voice-processor'. If the entry
    // ever registered something else, every default-constructed renderer would
    // throw on its first voice with an unhelpful "unknown processor" error.
    expect(CRATE_WORKLET_SOURCE).toContain('crate-voice-processor');
    expect(CRATE_WORKLET_SOURCE).toContain('registerProcessor');
  });

  it('carries the interpreter rather than a stub', () => {
    // A bundling mistake that resolves the ASL interpreter to an empty module
    // would still produce a file that registers a processor. Size is a crude
    // but effective guard: the real bundle is ~90 KB.
    expect(CRATE_WORKLET_SOURCE.length).toBeGreaterThan(40_000);
  });

  it('contains no bare import, because a worklet realm cannot resolve one', () => {
    // `audioWorklet.addModule` fetches one script and evaluates it in a realm
    // with no module resolution. A surviving `import ... from 'somewhere'`
    // fails at load with an error that names the URL, not the specifier, so
    // it is worth catching here where the cause is visible.
    const bareImport = /(^|\n)\s*import\s[^;]*\sfrom\s*['"][^.\/][^'"]*['"]/;
    expect(CRATE_WORKLET_SOURCE).not.toMatch(bareImport);
  });

  it('mints data URLs even where Blob is unavailable', () => {
    // Node has no `URL.createObjectURL`, which is precisely the fallback case
    // this function exists for. Getting two of three URLs here proves the
    // per-scheme isolation works rather than the whole thing throwing.
    const urls = crateWorkletUrls();
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.some((u) => u.startsWith('data:text/javascript;base64,'))).toBe(true);
    expect(urls.some((u) => u.startsWith('data:text/javascript,'))).toBe(true);
  });

  it('round-trips the source through its own base64 URL', () => {
    // Widening UTF-8 a byte at a time before btoa is easy to get subtly
    // wrong, and wrong here means a worklet that fails to parse on exactly
    // the browsers that need the data URL. Decode it back and compare.
    const url = crateWorkletUrls().find((u) => u.startsWith('data:text/javascript;base64,'))!;
    const decoded = Buffer.from(url.slice('data:text/javascript;base64,'.length), 'base64').toString('utf8');
    expect(decoded).toBe(CRATE_WORKLET_SOURCE);
  });
});
