/**
 * iOS Safari output for a *hosted* AudioContext (the engine's, not ours).
 *
 * The editor already has this. The three.js demo did not, which is why
 * stones were silent on an iPhone and fine on a laptop.
 *
 * Three separate facts, all required:
 *
 * 1. `resume()`, a silent buffer tap, the keep-alive oscillator, and
 *    `HTMLAudioElement.play()` must run in the same turn as the tap.
 *    After the first `await`, iOS no longer treats `resume()` as a
 *    user gesture.
 *
 * 2. Web Audio `destination` is muted when the Ring/Silent switch is
 *    Silent. An `HTMLAudioElement` playing a `MediaStreamDestination`
 *    uses the media-playback route and stays audible.
 *
 * 3. Desktop: `destination` only. iOS: HTML sink plus `destination`
 *    until the element is actually playing, then drop `destination`.
 *    Both at once is the doubled chorus. Dropping `destination` while
 *    the element is paused, or when desktop Chrome emulated an iPhone
 *    (`maxTouchPoints > 1`) and `play()` never really started, is the
 *    silent-desktop bug. `shouldConnectWebAudioDestination` is the
 *    gate the editor uses.
 *
 * Do not create a second AudioContext. iOS will not keep two alive.
 * Unlock the listener the engine already owns.
 */

let htmlOut: HTMLAudioElement | null = null;
let htmlSink: MediaStreamAudioDestinationNode | null = null;
let htmlSinkAttached = false;
let keepAlive: { osc: OscillatorNode; gain: GainNode; ctx: AudioContext } | null = null;
let unlockedFor: AudioContext | null = null;

export function prefersHtmlAudioSink(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  maxTouchPoints: number = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0,
  platform: string = typeof navigator !== 'undefined' ? navigator.platform : '',
): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (platform === 'MacIntel' && maxTouchPoints > 1) return true;
  return false;
}

function tapSilentBuffer(ctx: AudioContext): void {
  const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  try {
    source.start(0);
  } catch {
    /* already started */
  }
}

function startKeepAlive(ctx: AudioContext): void {
  if (keepAlive?.ctx === ctx) return;
  keepAlive = null;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 20;
  gain.gain.value = 0.00008;
  osc.connect(gain);
  gain.connect(ctx.destination);
  try {
    osc.start();
  } catch {
    /* already started */
  }
  keepAlive = { osc, gain, ctx };
}

function armHtmlSink(ctx: AudioContext): MediaStreamAudioDestinationNode | null {
  if (!prefersHtmlAudioSink()) return htmlSink;
  if (htmlSink && htmlSink.context !== ctx) {
    htmlSink = null;
    htmlSinkAttached = false;
  }
  if (!htmlSink) {
    htmlSink = ctx.createMediaStreamDestination();
    htmlSinkAttached = false;
  }
  if (!htmlOut) {
    htmlOut = new Audio();
    htmlOut.setAttribute('playsinline', 'true');
    htmlOut.setAttribute('webkit-playsinline', 'true');
    htmlOut.autoplay = true;
    htmlOut.preload = 'auto';
    htmlOut.style.position = 'fixed';
    htmlOut.style.width = '1px';
    htmlOut.style.height = '1px';
    htmlOut.style.opacity = '0.01';
    htmlOut.style.pointerEvents = 'none';
    document.body.appendChild(htmlOut);
  }
  if (!htmlSinkAttached) {
    htmlOut.srcObject = htmlSink.stream;
    htmlSinkAttached = true;
  }
  void htmlOut.play().catch(() => {
    /* need another gesture */
  });
  if (keepAlive) {
    try {
      keepAlive.gain.connect(htmlSink);
    } catch {
      /* already connected */
    }
  }
  return htmlSink;
}

/**
 * Must run in the same turn as a tap. After the first `await`, iOS no
 * longer treats `resume()` as a user gesture.
 *
 * `mix` is THREE.AudioListener.gain, already connected to `destination`.
 */
export function unlockHostedAudio(ctx: AudioContext, mix?: AudioNode | null): AudioContext {
  const htmlReady = !prefersHtmlAudioSink() || Boolean(htmlOut && !htmlOut.paused);
  if (unlockedFor === ctx && ctx.state === 'running' && htmlReady) {
    attachNodeToHtmlSink(mix, ctx.destination);
    return ctx;
  }
  if (ctx.state !== 'running') {
    void ctx.resume();
  }
  tapSilentBuffer(ctx);
  startKeepAlive(ctx);
  armHtmlSink(ctx);
  attachNodeToHtmlSink(mix, ctx.destination);
  unlockedFor = ctx;
  return ctx;
}

export function getHtmlAudioSink(): MediaStreamAudioDestinationNode | null {
  return htmlSink;
}

function htmlSinkIsPlaying(): boolean {
  return Boolean(htmlOut && !htmlOut.paused && htmlOut.readyState >= 2);
}

/**
 * iOS needs the HTML MediaStream tap when the Ring switch is Silent.
 * Once that element is actually playing, Web Audio `destination` is the
 * same signal a second time. Desktop never uses the HTML tap.
 */
export function shouldConnectWebAudioDestination(preferHtml: boolean, htmlPlaying: boolean): boolean {
  return !preferHtml || !htmlPlaying;
}

/**
 * Wire the mix so it cannot go nowhere, and so it is not heard twice.
 *
 * Desktop: `destination` only. iOS: HTML sink plus `destination` until the
 * element is playing, then drop `destination`.
 */
export function attachNodeToHtmlSink(
  node: { connect(dest: AudioNode): void; disconnect(dest?: AudioNode): void } | null | undefined,
  destination?: AudioNode,
): void {
  if (!node) return;
  if (htmlSink) {
    try {
      node.connect(htmlSink);
    } catch {
      /* already connected */
    }
    void htmlOut?.play().then(
      () => {
        if (destination && prefersHtmlAudioSink()) {
          try {
            node.disconnect(destination);
          } catch {
            /* not connected */
          }
        }
      },
      () => {
        /* need another gesture */
      },
    );
  }
  if (destination && shouldConnectWebAudioDestination(prefersHtmlAudioSink(), htmlSinkIsPlaying())) {
    try {
      node.connect(destination);
    } catch {
      /* already connected */
    }
  }
}

export function describeHostedAudio(): string {
  const sink = htmlSink ? (htmlOut && !htmlOut.paused && htmlOut.readyState >= 2 ? 'html-playing' : 'html-paused') : 'none';
  return `htmlSink=${sink} preferHtml=${prefersHtmlAudioSink()}`;
}
