/**
 * One AudioContext for the editor.
 *
 * iOS Safari will not keep two contexts alive. Play used to
 * `new AudioContext()` a second time. The crate graph ran for a buffer or
 * two (a synth click), then iOS killed the session.
 *
 * iOS also ignores Web Audio `destination` when the Ring/Silent switch is
 * on Silent. An HTMLAudioElement playing the same graph via a
 * MediaStreamDestination uses the media-playback route and stays audible.
 */

export interface WebAudioEngineOptions {
  sampleRate?: number | null;
  bufferMs?: number;
}

let engineOptions: WebAudioEngineOptions = {};
let shared: AudioContext | null = null;
let htmlOut: HTMLAudioElement | null = null;
let htmlSink: MediaStreamAudioDestinationNode | null = null;
/**
 * Whether the audio element is pointed at the sink that currently exists.
 * The element outlives a context; its stream does not, so replacing the
 * context has to re-point it or iOS plays a stream nobody is feeding.
 */
let htmlSinkAttached = false;
let keepAlive: { osc: OscillatorNode; gain: GainNode } | null = null;
let wantRunning = false;
/**
 * The context the watcher is currently installed on, not a boolean. Closing
 * a failed context and building a new one has to install a watcher on the
 * new one; a one-shot flag left the replacement unwatched, which is silent
 * until the day audio needs recovering and does not.
 */
let watched: AudioContext | null = null;

export function prefersHtmlAudioSink(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  maxTouchPoints: number = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0,
  platform: string = typeof navigator !== 'undefined' ? navigator.platform : '',
): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (platform === 'MacIntel' && maxTouchPoints > 1) return true;
  return false;
}

export function setWebAudioEngineOptions(options: WebAudioEngineOptions): void {
  engineOptions = options;
}

/**
 * Chrome treats a numeric latencyHint as seconds of output buffer. Asking
 * for 0.002 to 0.010 on a loaded graph makes Core Audio time-stretch when
 * the callback slips, which sounds like the mix dragging and then catching
 * up. Categories keep the device at a stable rate.
 */
export function latencyHintForBufferMs(
  bufferMs: number | undefined,
): AudioContextOptions['latencyHint'] | undefined {
  if (bufferMs == null || !(bufferMs > 0)) return undefined;
  if (bufferMs <= 3) return 'interactive';
  if (bufferMs <= 10) return 'balanced';
  return 'playback';
}

function createAudioContext(): AudioContext {
  const opts: AudioContextOptions = {};
  if (engineOptions.sampleRate) opts.sampleRate = engineOptions.sampleRate;
  const hint = latencyHintForBufferMs(engineOptions.bufferMs);
  if (hint != null) opts.latencyHint = hint;
  try {
    return new window.AudioContext(opts);
  } catch {
    const fallback: AudioContextOptions = {};
    if (engineOptions.sampleRate) fallback.sampleRate = engineOptions.sampleRate;
    if (hint != null) fallback.latencyHint = hint;
    return new window.AudioContext(fallback);
  }
}

export function getSharedWebAudioContext(): AudioContext {
  if (shared && shared.state !== 'closed') return shared;
  shared = createAudioContext();
  htmlSink = null;
  keepAlive = null;
  resetResumeBackoff();
  installWatch(shared);
  console.info(
    `[editor] audio context created state=${shared.state} sampleRate=${shared.sampleRate}` +
      (engineOptions.bufferMs != null ? ` bufferMs=${engineOptions.bufferMs}` : ''),
  );
  return shared;
}

/** Closes the current context so the next get uses the latest engine options. */
export function resetSharedWebAudioContext(): AudioContext {
  if (shared && shared.state !== 'closed') releaseSharedContext(shared);
  return getSharedWebAudioContext();
}

export function readSharedWebAudio(): {
  sampleRate: number | null;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  state: string;
} {
  if (!shared || shared.state === 'closed') {
    return { sampleRate: null, baseLatencyMs: null, outputLatencyMs: null, state: 'idle' };
  }
  const output = 'outputLatency' in shared ? Number((shared as AudioContext).outputLatency) : Number.NaN;
  return {
    sampleRate: shared.sampleRate,
    baseLatencyMs: Number.isFinite(shared.baseLatency) ? shared.baseLatency * 1000 : null,
    outputLatencyMs: Number.isFinite(output) ? output * 1000 : null,
    state: shared.state,
  };
}

export function setWebAudioWantRunning(on: boolean): void {
  wantRunning = on;
  // Asking for audio again is a fresh intent, from a person who may well
  // have just fixed whatever was wrong with their device.
  if (on) resetResumeBackoff();
}

/**
 * Resuming a context that cannot start is not free, and it is not local.
 *
 * When the output device fails, the browser suspends the context and fires
 * `statechange`. Answering that with `resume()` fires another `statechange`
 * when it fails, which was answered with another `resume()`, and so on with
 * nothing between the two. Each turn of that is a renderer-to-browser round
 * trip asking to open an audio stream, so a dead audio device stopped being
 * "no sound" and became tens of thousands of inter-process messages a second
 * and a machine too busy to use.
 *
 * So retries back off and then stop. A context that actually reaches
 * `running` clears the count, which is what keeps an ordinary iOS
 * suspend-on-background and resume-on-foreground instant.
 */
const RESUME_ATTEMPT_LIMIT = 6;
let resumeAttempts = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let resumeGaveUp = false;

function resetResumeBackoff(): void {
  resumeAttempts = 0;
  resumeGaveUp = false;
  if (resumeTimer !== null) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
}

function scheduleResume(ctx: AudioContext): void {
  if (resumeTimer !== null || resumeGaveUp) return;
  if (!wantRunning || ctx.state === 'running' || ctx.state === 'closed') return;
  if (resumeAttempts >= RESUME_ATTEMPT_LIMIT) {
    resumeGaveUp = true;
    console.warn(
      '[editor] audio context will not start after ' +
        `${RESUME_ATTEMPT_LIMIT} attempts; the output device is refusing it. ` +
        'Closing it and not retrying. Fix the device, then press play again.',
    );
    // Closing is the part that actually costs the browser nothing more.
    // Backing off only stops *our* resume calls; the browser keeps trying to
    // open an output stream for as long as a context exists that wants one,
    // and on a machine whose audio device has failed that retry is a storm
    // of inter-process messages with no JavaScript in it at all. Releasing
    // the context ends it. The next gesture builds a fresh one.
    releaseSharedContext(ctx);
    return;
  }
  // 50, 100, 200, 400, 800, 1600 ms.
  const delay = 50 * 2 ** resumeAttempts;
  resumeAttempts += 1;
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    if (!wantRunning || ctx.state === 'running' || ctx.state === 'closed') return;
    void ctx.resume().catch(() => {
      /* the statechange handler decides what happens next */
    });
  }, delay);
}

/** Drops a context that cannot run, so nothing downstream holds the device. */
function releaseSharedContext(ctx: AudioContext): void {
  if (watched === ctx) watched = null;
  keepAlive = null;
  htmlSink = null;
  htmlSinkAttached = false;
  if (shared === ctx) shared = null;
  try {
    void ctx.close();
  } catch {
    /* already going away */
  }
}

function installWatch(ctx: AudioContext): void {
  if (watched === ctx) return;
  watched = ctx;
  ctx.addEventListener('statechange', () => {
    console.info(`[editor] audio context state=${ctx.state} wantRunning=${wantRunning}`);
    if (ctx.state === 'running') {
      resetResumeBackoff();
      return;
    }
    if (ctx.state !== 'closed') scheduleResume(ctx);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Coming back to the tab is a fresh reason to try, so it clears a
    // give-up from a device that may since have come back.
    resetResumeBackoff();
    scheduleResume(ctx);
  });
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
  if (keepAlive) return;
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
  keepAlive = { osc, gain };
}

function armHtmlSink(ctx: AudioContext): MediaStreamAudioDestinationNode | null {
  if (!prefersHtmlAudioSink()) return htmlSink;
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
 * longer treats resume() as a user gesture.
 */
export function unlockWebAudio(): AudioContext {
  const ctx = getSharedWebAudioContext();
  if (ctx.state !== 'running') {
    void ctx.resume();
  }
  tapSilentBuffer(ctx);
  startKeepAlive(ctx);
  armHtmlSink(ctx);
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

export function describeAudioOutput(): string {
  const sink = htmlSink ? (htmlSinkIsPlaying() ? 'html-playing' : 'html-paused') : 'none';
  return `htmlSink=${sink} preferHtml=${prefersHtmlAudioSink()}`;
}

