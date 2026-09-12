/**
 * Numbers the graph and the reference port both need.
 *
 * Their own file so the material does not import `reference/DrumKernel` for
 * three constants and drag a second copy of the DSP into the bundle with
 * them.
 */

/** `kDefaultIRLength` / `kIRPartSize` in `dsp/homecrate_drumDSPKernel.mm`. */
export const DEFAULT_IR_LENGTH = 1024;
export const IR_PART_SIZE = 512;

/** The character IR's own filter: 18 dB/oct at 17 kHz with a modest bump. */
export const DEFAULT_IR_CUTOFF = 17000;
export const DEFAULT_IR_RESONANCE = 0.18;

/**
 * vDSP's zrip round trip leaves the convolution at twice its true value, and
 * that gain is what the plugin ships.
 */
export const IR_FFT_GAIN = 2;
