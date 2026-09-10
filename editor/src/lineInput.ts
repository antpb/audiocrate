import { listInputs, type AudioInputPort } from './host/crateAudioInput';

export type { AudioInputPort };

/**
 * Capture devices for the Line inspector. Asks for mic permission once if
 * labels are still blank.
 */
export async function listLineInputs(): Promise<AudioInputPort[]> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md || typeof md.enumerateDevices !== 'function') return listInputs();
  const devices = await md.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  if (inputs.length > 0 && inputs.every((device) => !device.label)) return listInputs();
  const ports: AudioInputPort[] = [];
  for (const device of inputs) {
    if (device.deviceId === 'default' || device.deviceId === 'communications') continue;
    ports.push({
      uid: device.deviceId,
      name: device.label || 'Audio Input',
      channelCount: 2,
    });
  }
  return ports;
}
