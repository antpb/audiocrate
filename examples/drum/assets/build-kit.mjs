/**
 * Converts the shipping kit's samples into the form the editor loads.
 *
 * Source is `example/ios/DefaultProfiles/DrumSamples/`, which the iOS app
 * ships as 24-bit stereo at 48 kHz. Two changes on the way in, both because
 * of what actually gets played rather than to save space for its own sake:
 *
 *   - Mono. `samplePlay` reads one channel of its buffer, so a stereo asset
 *     has a side that can never be heard. The fold is (L + R) / 2 rather
 *     than the left channel alone, which is the nearer thing to the stereo
 *     original.
 *   - 16-bit. Under a bit crusher whose whole job is to throw away depth,
 *     the difference is not reachable.
 *
 * Together that is a third of the bytes, which matters when the editor is
 * being opened on a phone.
 *
 *   node examples/drum/assets/build-kit.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source =
  process.env.DRUM_SAMPLES ??
  resolve(here, '../../../../../../example/ios/DefaultProfiles/DrumSamples');

function readWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') throw new Error('not a RIFF file');
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data' && fmt) {
      const frames = Math.floor(size / ((fmt.bits / 8) * fmt.channels));
      const mono = new Float32Array(frames);
      const step = fmt.bits / 8;
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < fmt.channels; channel++) {
          const at = body + (frame * fmt.channels + channel) * step;
          if (fmt.bits === 24) {
            const raw = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8;
            sum += raw / 2147483648;
          } else if (fmt.bits === 16) {
            sum += view.getInt16(at, true) / 32768;
          } else if (fmt.bits === 32) {
            sum += view.getFloat32(at, true);
          } else {
            throw new Error(`unsupported bit depth ${fmt.bits}`);
          }
        }
        mono[frame] = sum / fmt.channels;
      }
      return { ...fmt, mono };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

function writeWav(mono, sampleRate) {
  const bytes = new Uint8Array(44 + mono.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + mono.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) {
    const clamped = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

mkdirSync(here, { recursive: true });
let total = 0;
for (const name of readdirSync(source).filter((file) => file.endsWith('.wav')).sort()) {
  const decoded = readWav(readFileSync(resolve(source, name)));
  const out = writeWav(decoded.mono, decoded.sampleRate);
  writeFileSync(resolve(here, name), out);
  total += out.byteLength;
  console.log(
    `${name.padEnd(26)} ${decoded.channels}ch ${decoded.bits}-bit -> mono 16-bit  ` +
      `${(out.byteLength / 1024).toFixed(0)} KB`,
  );
}
console.log(`${(total / 1024 / 1024).toFixed(2)} MB total`);
