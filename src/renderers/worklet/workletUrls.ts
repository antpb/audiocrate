import { CRATE_WORKLET_SOURCE } from './bundled.generated';

/**
 * Every URL a browser might accept for the same worklet module, best first.
 *
 * `audioWorklet.addModule` is one of the less uniform corners of Web Audio.
 * Engines disagree about which URL schemes a worklet module may be fetched
 * from, the disagreements move between versions, and a rejection surfaces as
 * an opaque `AbortError` long after the decision that caused it. Picking one
 * scheme means picking which browsers get sound.
 *
 * So crate does not pick. It hands `WebAudioRenderer` the whole list and the
 * renderer tries them in order, reporting every failure together if none work.
 * Three strings and a class of browser-specific silence goes away.
 *
 * The order is deliberate:
 *
 * 1. **`blob:`** first. It is a URL with an origin, devtools shows it
 *    as a source file, and it is what every current engine prefers.
 * 2. **`data:` base64** next, for engines that refuse blob URLs in a worklet
 *    context. Base64 rather than raw because the source contains characters
 *    that a bare data URL cannot carry unescaped.
 * 3. **`data:` percent-encoded** last. Larger than base64 and the most widely
 *    understood, so it is the one that tends to work when nothing else does.
 *
 * ## The URLs are minted once and never revoked
 *
 * A revoked blob URL cannot be added again. `addModule` may legitimately run
 * more than once, on a second `AudioContext`: an XR session restarting audio
 * after a device sleep, a test building a fresh context per case, a page that
 * tears down and rebuilds its engine. Revoking after the first load turns the
 * second one into a network error that names nothing.
 *
 * The cost is one blob per page, holding the worklet source. That is the same
 * memory the module occupies anyway.
 *
 * ## Calling this yourself
 *
 * You do not have to. `new WebAudioRenderer(ctx)` calls it for you. It is
 * exported for the host that wants to load the module into a context it owns
 * before crate touches it, or to inspect which scheme won.
 *
 * @param source The module to publish. Defaults to crate's own worklet. Pass
 *   your own bundle here if you built an entry with extra kernels via
 *   `defineCrateVoiceProcessor` but still want the multi-scheme fallback.
 */
export function crateWorkletUrls(source: string = CRATE_WORKLET_SOURCE): string[] {
  const urls: string[] = [];

  // Each scheme is attempted independently. A worklet realm is not the only
  // constrained place crate runs: `Blob` and `URL.createObjectURL` are absent
  // in Node, `btoa` is absent in some workers, and a Content-Security-Policy
  // can make `createObjectURL` throw outright. Any one of them failing must
  // not cost the others, because the survivors are exactly the fallback this
  // function exists to provide.
  try {
    urls.push(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  } catch {
    /* no blob support here; the data URLs below still work */
  }

  try {
    // btoa takes latin1, so UTF-8 has to be widened a byte at a time first.
    // Doing this with `unescape(encodeURIComponent(...))` is shorter and
    // deprecated; this is the version that will still be correct later.
    const bytes = new TextEncoder().encode(source);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
    urls.push(`data:text/javascript;base64,${btoa(binary)}`);
  } catch {
    /* no btoa or no TextEncoder */
  }

  try {
    urls.push(`data:text/javascript,${encodeURIComponent(source)}`);
  } catch {
    /* encodeURIComponent cannot realistically fail, but a throw here must not
       lose the two URLs already collected */
  }

  return urls;
}

export { CRATE_WORKLET_SOURCE };
