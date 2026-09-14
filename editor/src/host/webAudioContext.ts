/**
 * One AudioContext for the editor.
 *
 * iOS Safari will not keep two contexts alive. Play used to
 * `new AudioContext()` a second time and iOS killed the session.
 *
 * iOS Silent switch mutes `destination`. The mix has to feed an
 * HTMLAudioElement through MediaStreamDestination or iOS is silent.
 * That stream is 44.1 kHz on Safari, so the context opens at 44.1 kHz
 * unless the user asked for something else. If the opened rate still
 * differs, the element playbackRate is the ratio, not a clip stretch.
 *
 * Desktop never uses the HTML tap. Destination stays connected on
 * every platform. Disconnecting it when HTML called play() is what
 * left meters running and speakers dead.
 */

export interface WebAudioEngineOptions {
  sampleRate?: number | null;
  bufferMs?: number;
}

let engineOptions: WebAudioEngineOptions = {};
let shared: AudioContext | null = null;
let htmlOut: HTMLAudioElement | null = null;
let htmlSink: MediaStreamAudioDestinationNode | null = null;
let htmlSinkAttached = false;
let keepAlive: { osc: OscillatorNode; gain: GainNode } | null = null;
let wantRunning = false;
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

export function latencyHintForBufferMs(
  bufferMs: number | undefined,
): AudioContextOptions['latencyHint'] {
  if (bufferMs != null && bufferMs > 0 && bufferMs <= 3) return 'interactive';
  return 'playback';
}

export function audioContextOptionsForDevice(
  options: WebAudioEngineOptions,
  ios: boolean,
): AudioContextOptions {
  const opts: AudioContextOptions = {
    latencyHint: ios ? 'playback' : latencyHintForBufferMs(options.bufferMs),
  };
  if (options.sampleRate) opts.sampleRate = options.sampleRate;
  else if (ios) opts.sampleRate = 44100;
  return opts;
}

export function htmlPlaybackRateForStream(contextRate: number, streamRate: number | undefined): number {
  if (!(contextRate > 0) || !(streamRate && streamRate > 0)) return 1;
  if (Math.abs(contextRate - streamRate) < 1) return 1;
  return contextRate / streamRate;
}

function createAudioContext(): AudioContext {
  const ios = prefersHtmlAudioSink();
  const opts = audioContextOptionsForDevice(engineOptions, ios);
  try {
    return new window.AudioContext(opts);
  } catch {
    try {
      return new window.AudioContext({ latencyHint: 'playback', sampleRate: ios ? 44100 : undefined });
    } catch {
      return new window.AudioContext();
    }
  }
}

export function getSharedWebAudioContext(): AudioContext {
  if (shared && shared.state !== 'closed') return shared;
  shared = createAudioContext();
  htmlSink = null;
  keepAlive = null;
  htmlSinkAttached = false;
  resetResumeBackoff();
  installWatch(shared);
  console.info(
    `[editor] audio context created state=${shared.state} sampleRate=${shared.sampleRate}` +
      ` latencyHint=${audioContextOptionsForDevice(engineOptions, prefersHtmlAudioSink()).latencyHint}` +
      (engineOptions.bufferMs != null ? ` bufferMs=${engineOptions.bufferMs}` : ''),
  );
  return shared;
}

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
  if (on) resetResumeBackoff();
}

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
    releaseSharedContext(ctx);
    return;
  }
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

function streamSampleRate(stream: MediaStream): number | undefined {
  const rate = stream.getAudioTracks()[0]?.getSettings()?.sampleRate;
  return typeof rate === 'number' && rate > 0 ? rate : undefined;
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
  htmlOut.playbackRate = htmlPlaybackRateForStream(ctx.sampleRate, streamSampleRate(htmlSink.stream));
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

export function shouldConnectWebAudioDestination(_preferHtml = false, _htmlPlaying = false): boolean {
  return true;
}

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
    void htmlOut?.play().catch(() => {
      /* need another gesture */
    });
  }
  if (destination) {
    try {
      node.connect(destination);
    } catch {
      /* already connected */
    }
  }
}

export function describeAudioOutput(): string {
  const sink = htmlSink ? (htmlOut && !htmlOut.paused ? 'html-playing' : 'html-paused') : 'none';
  return `mix=destination+${sink} preferIos=${prefersHtmlAudioSink()}`;
}
