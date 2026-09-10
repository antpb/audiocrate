import { KEYBOARD_KIND, isKeyboardKind } from './analogKeyboard';
import {
  MIDI_IN_KIND,
  MIDI_OUT_KIND,
  isMidiInKind,
  isMidiIoKind,
  isMidiOutKind,
} from '../../src/index';

export const MASTER_KIND = 'master';
export const LINE_KIND = 'line';
export const MIDICLIP_KIND = 'midiclip';

export function isMasterKind(kind: string): boolean {
  return kind === MASTER_KIND;
}

export function isLineKind(kind: string): boolean {
  return kind === LINE_KIND;
}

export function isMidiClipKind(kind: string): boolean {
  return kind === MIDICLIP_KIND;
}

export function isHostToolKind(kind: string): boolean {
  return (
    isKeyboardKind(kind) ||
    isMasterKind(kind) ||
    isLineKind(kind) ||
    isMidiClipKind(kind) ||
    isMidiIoKind(kind)
  );
}

export {
  KEYBOARD_KIND,
  isKeyboardKind,
  MIDI_IN_KIND,
  MIDI_OUT_KIND,
  isMidiInKind,
  isMidiOutKind,
  isMidiIoKind,
};
