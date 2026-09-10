/**
 * Types for the worklet build script, which is plain `.mjs` because it runs
 * under `node` with no compile step (it is what produces the code the rest of
 * the build consumes, so it cannot depend on that build having happened).
 *
 * `bundledWorklet.test.ts` imports it to regenerate the bundle and compare,
 * which is the whole staleness guard, and that import is the only reason these
 * declarations need to exist.
 */

/** Bundles the worklet entry with esbuild and returns the JavaScript as a string. */
export function bundleWorklet(): Promise<string>;

/** The exact text of `bundled.generated.ts` for a given bundle. */
export function renderGeneratedModule(source: string): string;

/** True when the checked-in generated module already matches `source`. */
export function generatedIsCurrent(source: string): Promise<boolean>;

/** Absolute path of the worklet entry point. */
export const WORKLET_ENTRY: string;

/** Absolute path of the checked-in generated module. */
export const GENERATED_TS: string;

/** Absolute path of the standalone worklet asset written into `dist/`. */
export const DIST_JS: string;
