import { describe, expect, it } from 'vitest';
import {
  androidChromeUsbHint,
  deviceConstraint,
  grantedInputDeviceId,
  inputConstraintAttempts,
  inputConstraintRisk,
  inputOpenedAsRequested,
  preferUsbCaptureId,
} from '../src/host/crateAudioInput';

describe('line input device choice', () => {
  it('treats Android as the risky getUserMedia path', () => {
    expect(inputConstraintRisk('Mozilla/5.0 (Linux; Android 15; Pixel) Chrome/130.0.0.0')).toBe('android');
    expect(inputConstraintRisk('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15')).toBe(
      'safe',
    );
    expect(inputConstraintRisk('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0')).toBe('safe');
  });

  it('asks Android for the device first, without sampleRate or latency', () => {
    const attempts = inputConstraintAttempts('usb-1', 48000, 'android');
    expect(attempts[0]).toEqual({
      deviceId: { exact: 'usb-1' },
      echoCancellation: { exact: false },
      noiseSuppression: { exact: false },
      autoGainControl: { exact: false },
    });
    expect(attempts.some((audio) => 'sampleRate' in audio || 'latency' in audio)).toBe(false);
  });

  it('keeps the low-latency ask on desktop and iOS', () => {
    const first = inputConstraintAttempts('mic-1', 48000, 'safe')[0];
    expect(first?.deviceId).toEqual({ exact: 'mic-1' });
    expect(first?.sampleRate).toEqual({ ideal: 48000 });
    expect(first?.latency).toEqual({ ideal: 0 });
  });

  it('does not pin system default to an exact deviceId', () => {
    expect(deviceConstraint(null)).toEqual({});
    expect(deviceConstraint('default')).toEqual({});
  });

  it('rejects a track that reported a different device', () => {
    expect(inputOpenedAsRequested('usb-1', 'mic-builtin')).toBe(false);
    expect(inputOpenedAsRequested('usb-1', 'usb-1')).toBe(true);
    expect(inputOpenedAsRequested('usb-1', null)).toBe(true);
    expect(inputOpenedAsRequested(null, 'mic-builtin')).toBe(true);
  });

  it('rejects USB selection when the live track is the phone mic', () => {
    expect(inputOpenedAsRequested('usb-1', null, 'USB audio', 'Microphone')).toBe(false);
    expect(inputOpenedAsRequested('usb-1', null, 'USB audio', 'USB audio', true)).toBe(false);
    expect(inputOpenedAsRequested('usb-1', null, 'USB audio', 'USB audio', false, 8000)).toBe(false);
    expect(inputOpenedAsRequested('usb-1', null, 'USB audio', 'USB audio', false, 44100)).toBe(true);
  });

  it('prefers the input that shares the USB output group', () => {
    const devices = [
      { deviceId: 'phone', kind: 'audioinput', label: 'Microphone', groupId: 'a' },
      { deviceId: 'usb-out', kind: 'audiooutput', label: 'USB audio', groupId: 'usb' },
      { deviceId: 'usb-in', kind: 'audioinput', label: 'USB audio', groupId: 'usb' },
      { deviceId: 'usb-lie', kind: 'audioinput', label: 'USB audio', groupId: 'a' },
    ];
    expect(preferUsbCaptureId(devices, 'phone')).toBe('phone');
    expect(preferUsbCaptureId(devices, 'usb-lie')).toBe('usb-in');
    expect(preferUsbCaptureId(devices, 'usb-in')).toBe('usb-in');
  });

  it('warns only on Android Chrome USB capture', () => {
    expect(androidChromeUsbHint('Mozilla/5.0 (Linux; Android 15; Pixel) Chrome/130.0.0.0')).toMatch(/USB/);
    expect(androidChromeUsbHint('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15')).toBeNull();
  });

  it('reads the granted id from track settings', () => {
    expect(grantedInputDeviceId({ getSettings: () => ({ deviceId: 'usb-1' }) })).toBe('usb-1');
    expect(grantedInputDeviceId({ getSettings: () => ({}) })).toBeNull();
  });
});
