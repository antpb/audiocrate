/** OfflineRenderer-based render-diff harness. CI/Node-only. */
export { OfflineRenderer } from '../renderers/OfflineRenderer';
export type { OfflineRenderOptions, OfflineRenderResult } from '../renderers/OfflineRenderer';
export { renderDiff, writeGoldenFixture } from './renderDiff';
export type { RenderDiffOptions, RenderDiffResult } from './renderDiff';
export { encodeWavFloat32, decodeWavFloat32 } from './wav';
export type { WavFile } from './wav';
/**
 * A conforming portable kernel (`renderers/kernels/wasmKernel.ts`). Exported
 * from the testing barrel rather than the main one on purpose: it is a
 * reference and a fixture, not DSP anyone should ship. A kernel author can
 * load it to confirm their host is wired correctly before suspecting their
 * own module.
 */
export {
  buildWasmKernelFixture,
  WASM_KERNEL_FIXTURE_DESCRIPTOR,
  FIXTURE_GAIN_PARAM_ID,
} from './wasmKernelFixture';
