/**
 * URL of the worklet Vite built for this editor session.
 *
 * The import names crate's own processor. `vite-worklet-plugin` remaps any
 * `crate-voice-processor...?worklet` to the entry in editor/vite.config.ts:
 * homecrate's processor when that package is next to crate, otherwise crate's.
 */
import workletUrl from '../../../src/renderers/worklet/crate-voice-processor.ts?worklet';

export const EDITOR_WORKLET_URL: string | readonly string[] = workletUrl;
