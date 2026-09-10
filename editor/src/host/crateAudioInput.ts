/**
 * Device enumeration and capture for the Line inspector.
 *
 * Device labels are empty until the page has been granted microphone
 * permission once. `listInputs()` asks before enumerating.
 *
 * Chrome applies echo cancellation, noise suppression, and AGC by default.
 * All three are disabled here: they wreck instrument input, and AGC fights
 * an amp sim's input gain.
 */

export interface AudioInputPort {
  uid: string;
  name: string;
  channelCount: number;
}

let permissionStream: MediaStream | null = null;

function mediaDevices(): MediaDevices | null {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md || typeof md.getUserMedia !== 'function') return null;
  return md;
}

/**
 * Requests microphone permission once and keeps the resulting stream open
 * only long enough to read labels. Without a granted permission,
 * `enumerateDevices` returns entries whose `label` is an empty string.
 */
async function ensurePermission(): Promise<void> {
  const md = mediaDevices();
  if (!md || permissionStream) return;
  try {
    permissionStream = await md.getUserMedia({ audio: true });
  } catch {
    // Denied or no device: enumeration still works, labels stay blank.
    permissionStream = null;
  }
}

/** Releases the permission-probe stream. The mic indicator stays on while it is open. */
function releasePermissionStream(): void {
  if (!permissionStream) return;
  for (const track of permissionStream.getTracks()) track.stop();
  permissionStream = null;
}

/**
 * Enumerates audio input devices in the shape the recorder's input picker
 * expects. `channelCount` is what the device reports as its maximum, which
 * is how the picker decides whether to offer stereo pairs and per-channel
 * options.
 */
export async function listInputs(): Promise<AudioInputPort[]> {
  const md = mediaDevices();
  if (!md || typeof md.enumerateDevices !== 'function') return [];

  await ensurePermission();
  const devices = await md.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');

  const ports: AudioInputPort[] = [];
  for (const device of inputs) {
    // A "default"/"communications" alias duplicates a real device; keeping
    // both makes the picker show the same interface twice.
    if (device.deviceId === 'default' || device.deviceId === 'communications') continue;
    ports.push({
      uid: device.deviceId,
      name: device.label || 'Audio Input',
      // Assumed, NOT probed. Asking each device for its real channel count
      // means opening every device, which physically activates all of them:
      // camera lights come on, networked/continuity devices start streaming.
      // Enumerating a device list must never do that. The real count is read
      // from the granted track in `openInput` once a device is actually
      // chosen, and 2 here just lets the picker offer a stereo pair plus
      // per-channel options, which is the useful case for an interface.
      channelCount: 2,
    });
  }
  releasePermissionStream();
  return ports;
}

export interface OpenInputResult {
  /** Feed this into `AudioScene.startMonitoring` / a recorder tap. */
  node: AudioNode;
  stream: MediaStream;
  /** Actual channels the granted stream carries, which may be fewer than requested. */
  channelCount: number;
  close(): void;
}

/**
 * Opens one device and returns a node carrying the requested channel
 * selection.
 *
 * `channel` is 0-based and `span` is 1 (mono) or 2 (a stereo pair), the same
 * shape `MonitorDescriptor` uses natively. A negative channel means "take
 * the stream as-is". When the requested channels exceed what the stream
 * actually carries the selection falls back to the whole stream rather than
 * producing silence, since a silent monitor path is far harder to diagnose
 * than a wrong-channel one.
 */
export async function openInput(
  ctx: AudioContext,
  deviceId: string | null,
  channel = -1,
  span = 2,
): Promise<OpenInputResult> {
  const md = mediaDevices();
  if (!md) throw new Error('getUserMedia is unavailable (needs localhost or HTTPS)');

  const base: MediaTrackConstraints = {
    ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
    channelCount: { ideal: Math.max(2, channel >= 0 ? channel + span : 2) },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({
      audio: {
        ...base,
        latency: { ideal: 0 },
        sampleRate: { ideal: ctx.sampleRate },
      },
    });
  } catch {
    stream = await md.getUserMedia({ audio: base });
  }

  const track = stream.getAudioTracks()[0];
  if (track?.applyConstraints) {
    await track.applyConstraints({ latency: { ideal: 0 } }).catch(() => {
      /* some engines reject a second latency ask; the getUserMedia one stands */
    });
  }
  const settings = track?.getSettings?.() as { channelCount?: number; latency?: number } | undefined;
  const channelCount = Math.max(1, settings?.channelCount ?? 1);
  if (settings?.latency != null) {
    console.info(`[editor] input latency=${(settings.latency * 1000).toFixed(2)} ms rate=${ctx.sampleRate}`);
  }

  const source = ctx.createMediaStreamSource(stream);
  let node: AudioNode = source;

  const wantsSelection = channel >= 0 && channel + span <= channelCount && channelCount > 1;
  if (wantsSelection) {
    const splitter = ctx.createChannelSplitter(channelCount);
    source.connect(splitter);
    if (span === 1) {
      // Mono take: one channel, duplicated to both sides so it is centred
      // rather than hard-panned into one ear.
      const merger = ctx.createChannelMerger(2);
      splitter.connect(merger, channel, 0);
      splitter.connect(merger, channel, 1);
      node = merger;
    } else {
      const merger = ctx.createChannelMerger(2);
      splitter.connect(merger, channel, 0);
      splitter.connect(merger, channel + 1, 1);
      node = merger;
    }
  }

  return {
    node,
    stream,
    channelCount,
    close() {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
