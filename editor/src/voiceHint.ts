import { isKeyboardKind, stealLabel } from './analogKeyboard';
import { isNoteInlet } from './controlInputs';
import type { PatchEditor } from './editor';
import type { AudioMaterial } from '../../src/index';

export function firstNoteTarget(editor: PatchEditor): AudioMaterial | null {
  for (const conn of editor.editor.getConnections()) {
    if (!isKeyboardKind(editor.kinds.get(conn.source) ?? '')) continue;
    if (!isNoteInlet(conn.targetInput)) continue;
    const material = editor.materials.get(conn.target);
    if (material) return material;
  }
  return null;
}

export function applyVoiceHint(
  editor: PatchEditor,
  analog: { setVoiceView: (view: { polyphony: number; steal: string; targetName: string }) => void; octave?: number },
): void {
  const material = firstNoteTarget(editor);
  analog.setVoiceView({
    polyphony: material?.polyphony ?? 1,
    steal: stealLabel(material?.voiceStealing),
    targetName: material?.name ?? '',
  });
  if (material?.kind === 'drum') analog.octave = 2;
}
