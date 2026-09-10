import type { AudioScene } from '../AudioScene';
import type { SceneSync } from './SceneSync';
import type { SceneEdit } from './edits';

/**
 * Binds a `SceneSync` to an `AudioScene`.
 *
 * Transport commands and master mixer writes travel as discrete edits
 * (last-write-wins per target). Playhead / playing / bpm also publish as
 * continuous peer state so a remote UI can draw them without driving the
 * local transport off interpolated packets.
 *
 * Returns an unsubscribe. The sync and the scene stay open.
 */
export function attachAudioScene(sync: SceneSync, scene: AudioScene): () => void {
  let applying = false;
  let lastMixer = mixerOf(scene);

  const unsubTransport = scene.transport.onTransportChange(() => {
    if (applying || !scene.isStarted) return;
    sync.sendEdit({
      target: 'transport',
      kind: 'transport',
      value: {
        action: scene.transport.state,
        position: scene.transport.position,
        bpm: scene.transport.bpm,
      },
    });
  });

  const applyRemote = (edit: SceneEdit) => {
    if (edit.peerId === sync.peerId) return;
    applying = true;
    try {
      applySceneEdit(scene, edit);
      if (edit.kind === 'mixer' && edit.target === 'master') lastMixer = mixerOf(scene);
    } finally {
      applying = false;
    }
  };

  const unsubEdit = sync.onEdit(applyRemote);
  const unsubConflict = sync.onConflict((conflict) => applyRemote(conflict.kept));

  const unsubTick = sync.onTick(() => {
    if (!scene.isStarted) return;
    sync.set('position', scene.transport.position);
    sync.set('playing', scene.transport.state === 'playing' ? 1 : 0);
    sync.set('bpm', scene.transport.bpm);
    if (applying) return;
    const mixer = mixerOf(scene);
    if (mixer.volume === lastMixer.volume && mixer.pan === lastMixer.pan && mixer.muted === lastMixer.muted) {
      return;
    }
    lastMixer = mixer;
    sync.sendEdit({
      target: 'master',
      kind: 'mixer',
      value: mixer,
    });
  });

  return () => {
    unsubTransport();
    unsubEdit();
    unsubConflict();
    unsubTick();
  };
}

export function applySceneEdit(scene: AudioScene, edit: SceneEdit): void {
  if (edit.kind === 'transport') {
    if (!scene.isStarted) return;
    const bpm = asNumber(edit.value.bpm);
    if (bpm != null) scene.transport.bpm = bpm;
    const position = asNumber(edit.value.position);
    const action = edit.value.action;
    if (action === 'playing') {
      if (position != null) scene.transport.seek(position);
      if (scene.transport.state !== 'playing') scene.transport.play();
    } else if (action === 'paused') {
      if (scene.transport.state === 'playing') scene.transport.pause();
      else if (position != null) scene.transport.seek(position);
    } else if (action === 'stopped') {
      scene.transport.stop();
    }
    return;
  }

  if (edit.kind === 'mixer') {
    const node = edit.target === 'master' ? scene.master : scene.tracks.find((track) => `track:${track.id}` === edit.target);
    if (!node) return;
    const volume = asNumber(edit.value.volume);
    const pan = asNumber(edit.value.pan);
    if (volume != null) node.volume = volume;
    if (pan != null) node.pan = pan;
    if (edit.value.muted === 1 || edit.value.muted === true) node.muted = true;
    if (edit.value.muted === 0 || edit.value.muted === false) node.muted = false;
    return;
  }

  if (edit.kind === 'clip') {
    const clip = findClip(scene, edit);
    if (!clip) return;
    const gainDb = asNumber(edit.value.gainDb);
    const fadeInSec = asNumber(edit.value.fadeInSec);
    const fadeOutSec = asNumber(edit.value.fadeOutSec);
    if (gainDb != null) clip.gainDb = gainDb;
    if (fadeInSec != null) clip.fadeInSec = fadeInSec;
    if (fadeOutSec != null) clip.fadeOutSec = fadeOutSec;
  }
}

function findClip(scene: AudioScene, edit: SceneEdit) {
  const id = asNumber(edit.value.clipId);
  const name = typeof edit.value.name === 'string' ? edit.value.name : null;
  const fromTarget = edit.target.startsWith('clip:') ? edit.target.slice(5) : '';
  const targetId = Number(fromTarget);
  for (const track of scene.tracks) {
    for (const scheduled of track.clips) {
      if (id != null && scheduled.clip.id === id) return scheduled.clip;
      if (Number.isFinite(targetId) && scheduled.clip.id === targetId) return scheduled.clip;
    }
  }
  const byName = name ?? (fromTarget && !Number.isFinite(targetId) ? fromTarget : null);
  if (!byName) return null;
  for (const track of scene.tracks) {
    for (const scheduled of track.clips) {
      if (scheduled.clip.name === byName) return scheduled.clip;
    }
  }
  return null;
}

function mixerOf(scene: AudioScene): { volume: number; pan: number; muted: number } {
  return {
    volume: scene.master.volume,
    pan: scene.master.pan,
    muted: scene.master.muted ? 1 : 0,
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
