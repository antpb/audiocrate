/**
 * Thrown when `scene.transport.play()` or a schedule call happens before
 * `scene.start()` has resolved. Named so it cannot be mistaken for silence.
 */
export class SceneNotStartedError extends Error {
  constructor(action: string) {
    super(
      `${action} requires the scene to be started first: call \`await scene.start()\` ` +
        `(from a user gesture, e.g. a click handler) before ${action}.`,
    );
    this.name = 'SceneNotStartedError';
  }
}

/** Thrown when `AudioMaterial.noteOn` is called before `bind(renderer)`. */
export class AudioMaterialNotBoundError extends Error {
  constructor(name: string) {
    super(`AudioMaterial "${name}".noteOn requires bind(renderer) first.`);
    this.name = 'AudioMaterialNotBoundError';
  }
}
