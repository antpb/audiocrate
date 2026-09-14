/**
 * Device enumeration and capture for the Line inspector.
 *
 * Device labels are empty until the page has been granted microphone
 * permission once. `listInputs()` asks before enumerating.
 *
 * Chrome applies echo cancellation, noise suppression, and AGC by default.
 * All three are disabled here: they wreck instrument input, and AGC fights
 * an amp sim's input gain.
 *
 * Android Chrome is a special case. Bundling `deviceId` with `sampleRate`,
 * `latency`, or `channelCount` often makes it ignore the selected device and
 * open the built-in mic anyway, without throwing. The picker then still says
 * "USB audio". Ask for the device first, then apply the rest to the track.
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

export function inputConstraintRisk(userAgent: string): 'android' | 'safe' {
  return /Android/i.test(userAgent) ? 'android' : 'safe';
}

export function deviceConstraint(deviceId: string | null): Pick<MediaTrackConstraints, 'deviceId'> {
  if (!deviceId || deviceId === 'default' || deviceId === 'communications') return {};
  return { deviceId: { exact: deviceId } };
}

export function grantedInputDeviceId(track: { getSettings?: () => { deviceId?: string } } | undefined): string | null {
  const id = track?.getSettings?.().deviceId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function looksLikeUsbInput(label: string): boolean {
  return /usb|wired headset|external|interface|scarlett|focusrite/i.test(label);
}

export function looksLikePhoneMic(label: string): boolean {
  return /microphone|built-?in|internal|phone mic|camcorder|voice/i.test(label) && !looksLikeUsbInput(label);
}

export function androidChromeUsbHint(userAgent: string): string | null {
  if (inputConstraintRisk(userAgent) !== 'android') return null;
  return 'Chrome on Android lists USB audio but often still captures the phone microphone. That is a browser limit. Firefox on this phone, or the native app, can open the USB input.';
}

/**
 * Chrome sometimes lists the USB interface as an output, or hands the
 * picker an id that is not in the USB group. Prefer the input that shares
 * the USB output's groupId.
 */
export function preferUsbCaptureId(
  devices: Array<{ deviceId: string; kind: string; label: string; groupId: string }>,
  selectedId: string | null,
): string | null {
  if (!selectedId) return selectedId;
  const selected = devices.find((device) => device.deviceId === selectedId);
  if (selected && !looksLikeUsbInput(selected.label)) return selectedId;
  const usbOut = devices.find((device) => device.kind === 'audiooutput' && looksLikeUsbInput(device.label));
  if (!usbOut) return selectedId;
  const groupedIn = devices.find(
    (device) =>
      device.kind === 'audioinput' &&
      device.groupId === usbOut.groupId &&
      device.deviceId !== 'default' &&
      device.deviceId !== 'communications',
  );
  if (!groupedIn) return selectedId;
  if (!selected || selected.groupId !== usbOut.groupId) return groupedIn.deviceId;
  return selectedId;
}

/**
 * Chrome on Android often reports the USB id (or no id) while the track is
 * still the phone mic. An empty id is not proof of success.
 */
export function inputOpenedAsRequested(
  requested: string | null,
  granted: string | null,
  requestedLabel = '',
  openedLabel = '',
  echoCancellation?: boolean,
  sampleRateMin?: number,
): boolean {
  if (!requested || requested === 'default' || requested === 'communications') return true;
  if (granted && granted !== requested) return false;
  if (requestedLabel && openedLabel && looksLikeUsbInput(requestedLabel) && looksLikePhoneMic(openedLabel)) {
    return false;
  }
  if (looksLikeUsbInput(requestedLabel) && echoCancellation === true) return false;
  if (looksLikeUsbInput(requestedLabel) && sampleRateMin != null && sampleRateMin <= 16000) return false;
  return true;
}

export function inputConstraintAttempts(
  deviceId: string | null,
  sampleRate: number,
  risk: 'android' | 'safe' = 'safe',
): MediaTrackConstraints[] {
  const device = deviceConstraint(deviceId);
  const processingOff: MediaTrackConstraints = {
    echoCancellation: { exact: false },
    noiseSuppression: { exact: false },
    autoGainControl: { exact: false },
  };
  const processingBool: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (risk === 'android') {
    const attempts: MediaTrackConstraints[] = [{ ...device, ...processingOff }, { ...device, ...processingBool }, { ...device }];
    if (deviceId && deviceId !== 'default') {
      attempts.push({ deviceId });
      attempts.push({
        advanced: [{ deviceId: { exact: deviceId } }],
        ...processingOff,
      });
    }
    return attempts;
  }
  return [
    {
      ...device,
      ...processingBool,
      channelCount: { ideal: 2 },
      latency: { ideal: 0 },
      sampleRate: { ideal: sampleRate },
    },
    { ...device, ...processingOff },
    { ...device },
  ];
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
    // `{ audio: true }` on Android Chrome opens the voice-call mic and can
    // pin the tab to it. Ask for unprocessed capture so labels appear
    // without locking the built-in source.
    const risk = inputConstraintRisk(typeof navigator !== 'undefined' ? navigator.userAgent : '');
    permissionStream = await md.getUserMedia({
      audio:
        risk === 'android'
          ? { echoCancellation: { exact: false }, noiseSuppression: { exact: false }, autoGainControl: { exact: false } }
          : true,
    });
  } catch {
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
  /** The id the track reported, which may be empty on Android. */
  deviceId: string | null;
  /** The track label after getUserMedia, the only name Chrome will admit. */
  label: string;
  close(): void;
}

async function requestedDeviceLabel(md: MediaDevices, deviceId: string | null): Promise<string> {
  if (!deviceId || typeof md.enumerateDevices !== 'function') return '';
  const devices = await md.enumerateDevices();
  return devices.find((device) => device.deviceId === deviceId)?.label ?? '';
}

async function getAudioStream(
  md: MediaDevices,
  deviceId: string | null,
  sampleRate: number,
): Promise<MediaStream> {
  releasePermissionStream();
  const risk = inputConstraintRisk(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  let targetId = deviceId;
  if (risk === 'android' && typeof md.enumerateDevices === 'function') {
    targetId = preferUsbCaptureId(await md.enumerateDevices(), deviceId);
  }
  const requestedLabel = await requestedDeviceLabel(md, targetId);
  let last: unknown;
  for (const audio of inputConstraintAttempts(targetId, sampleRate, risk)) {
    try {
      const stream = await md.getUserMedia({ audio });
      const track = stream.getAudioTracks()[0];
      const granted = grantedInputDeviceId(track);
      const openedLabel = track?.label ?? '';
      const settings = track?.getSettings?.() ?? {};
      const caps = typeof track?.getCapabilities === 'function' ? track.getCapabilities() : undefined;
      if (
        !inputOpenedAsRequested(
          targetId,
          granted,
          requestedLabel,
          openedLabel,
          settings.echoCancellation,
          caps?.sampleRate?.min,
        )
      ) {
        for (const next of stream.getTracks()) next.stop();
        last = new Error(
          `Opened "${openedLabel || granted || 'the phone microphone'}" instead of ${requestedLabel || 'the selected input'}. Chrome on Android lists USB audio but still captures the built-in mic. Firefox on this phone, or the native app, can open the USB device.`,
        );
        continue;
      }
      return stream;
    } catch (err) {
      last = err;
    }
  }
  if (last instanceof Error) throw last;
  throw new Error('Could not open the selected input');
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

  releasePermissionStream();
  const stream = await getAudioStream(md, deviceId, ctx.sampleRate);

  const track = stream.getAudioTracks()[0];
  if (track?.applyConstraints) {
    await track
      .applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: { ideal: 0 },
      })
      .catch(() => {
        /* Android often rejects a second constraint pass */
      });
  }
  const settings = track?.getSettings?.() as { channelCount?: number; latency?: number; deviceId?: string } | undefined;
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
    deviceId: grantedInputDeviceId(track) ?? deviceId,
    label: track?.label ?? '',
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
