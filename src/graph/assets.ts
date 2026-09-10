/**
 * What a Material carries besides its graph and its params: the files a
 * preset references, already decoded.
 *
 * Crate core knows two decoded shapes, text and audio: those are the two
 * things a loader can do without knowing what the bytes mean. A neural
 * model's JSON is text. An impulse response, a granular source loop, and a
 * drum sample are all audio. Everything past that (which key means what,
 * whether a missing one is fatal) belongs to the plugin that asked for the
 * file, so assets live in an open string-keyed map rather than as named
 * fields.
 *
 * That map is why crate core has no `namAsset` or `loopAsset` property. A
 * field per plugin file type is a framework that only its own author can
 * extend.
 */

/** A decoded text asset: a model definition, a preset, a config blob. */
export interface TextAssetData {
  filename: string;
  text: string;
}

/**
 * A decoded audio asset. Impulse responses are the canonical case and the
 * reason this is core rather than plugin-owned: convolving a space is a
 * general audio operation, not one plugin's feature.
 *
 * `samplesR` is present only when the source file was multi-channel and the
 * consumer can use both; a mono consumer reads `samples` and ignores it.
 */
export interface AudioAssetData {
  filename: string;
  samples: Float32Array;
  samplesR?: Float32Array;
  sampleRate: number;
}

/** An impulse response. Structurally an audio asset; named for what it is used for. */
export type IrAssetData = AudioAssetData;

/**
 * How a loader should turn bytes into an asset. `text` decodes UTF-8;
 * `audio` runs the bytes through `AudioLoader`.
 */
export type AssetDecodeKind = 'text' | 'audio';

/**
 * One file a preset references, described so a generic loader can fetch and
 * decode it without knowing the plugin.
 *
 * `library` is the host's own bucket name for where these files live
 * ('NAM', 'IR', 'samples', ...), matching how homecrate projects lay out
 * `assets/<library>/`. Crate does not interpret it; it hands it back to the
 * host's path resolver.
 */
export interface AssetRequest {
  /** Key to store the decoded asset under on the Material. */
  key: string;
  library: string;
  /**
   * Other buckets to look in when the primary one does not have the file.
   * Real archives drift: the same grain loop has shipped under both
   * `assets/samples/` and `assets/GrainLoops/` depending on the version that
   * wrote it, and an importer that only knows the current name silently loses
   * the asset.
   */
  fallbackLibraries?: readonly string[];
  filename: string;
  decode: AssetDecodeKind;
  /**
   * A missing optional asset is normal (a preset naming a cabinet IR the user
   * never exported). A missing required one is worth warning about.
   */
  optional?: boolean;
}
