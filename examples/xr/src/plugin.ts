/**
 * crate-stones: an XR Publisher plugin.
 *
 * Stones on a hillside. Each live one is a crate AudioMaterial on the audio
 * thread, spatialised through the engine's `AudioListener`, tuned per stone
 * from the world seed, and driven by the weather field. There are no audio
 * files.
 *
 * 1. **Voices are pooled by distance.** An `AudioWorkletNode` runs its
 *    process callback for as long as it is connected. At most `MAX_VOICES`
 *    stones are live, always the nearest.
 *
 * 2. **The glow is measured inside the graph.** `XRPublisher.getAudioAnalyser`
 *    taps the whole spatial mix. A `tap.meter` in the AudioMaterial measures that
 *    one voice, pre-panner, and costs nothing until a host asks for it.
 *
 * 3. **Nothing calls `Math.random()`.** XR Publisher requires a world
 *    identical for every visitor. Audiocrate's `noise` and `random` nodes are not
 *    reproducible, so the AudioMaterial builds excitation from deterministic
 *    primitives and takes per-stone variation from `spawn.rng`. See
 *    `materials/resonantStone.ts`.
 */
import { createCrateAudio, rendererFor, type CrateAudio, type ThreeListenerLike } from './CrateAudio';
import { resonantStoneMaterial } from './materials/resonantStone';

/** Loose shapes for the two globals the engine provides. */
interface Spawn {
  rng(): number;
  seed: string;
  renderPosition: [number, number, number];
  normalizedHeight: number;
  surface: string;
}

interface XRPublisherLike {
  registerDecoration(spec: unknown): unknown;
  getAudioListener(): ThreeListenerLike | null;
  getPlayerState(): { x: number; y: number; z: number } | null;
  getWeatherAt?(x: number, z: number): { speed?: number; rain?: number } | null;
}

type Object3DLike = {
  add(child: unknown): unknown;
  remove(child: unknown): unknown;
  userData: Record<string, unknown>;
  traverse(fn: (child: { geometry?: { dispose(): void } }) => void): void;
};

const PLUGIN_ID = 'crate-stones';

/**
 * How many stones may have a live crate voice at once.
 *
 * Each voice is one `AudioWorkletNode` evaluating a fused graph of about
 * thirty nodes at the sample rate. Twelve; the LOD keeps them the twelve
 * nearest.
 */
const MAX_VOICES = (() => {
  // A phone is not a laptop. Each voice is an AudioWorkletNode evaluating a
  // ~30-node fused graph at the sample rate, and a mobile audio thread that
  // misses its deadline does not degrade, it crackles. `hardwareConcurrency`
  // is a blunt proxy and deliberately so: the exact number matters far less
  // than not asking a 4-core phone for a desktop's budget.
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 8;
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (coarse || cores <= 4) return 4;
  if (cores <= 8) return 8;
  return 12;
})();

/** Beyond this, a stone is silent and its voice is returned to the pool. */
const AUDIBLE_RADIUS = 42;

/** How often the pool re-decides who is nearest. Not per frame; nothing moves that fast. */
const POOL_INTERVAL_MS = 250;

/** A pentatonic minor scale. Seeded pitches stay in one set of intervals. */
const SCALE = [0, 3, 5, 7, 10];
const ROOT_HZ = 146.83; // D3

if (typeof window !== 'undefined') {
  // The bridge, published for other plugins.
  //
  // XR Publisher plugins are flat, independent files with no shared module
  // system, so two crate-based plugins would each carry their own copy of
  // crate: about 34 kB gzipped, twice, and worse, two `WebAudioRenderer`
  // instances adding two identical worklet modules to the same context. A
  // second plugin can find this one instead. Same reason the engine itself
  // publishes `window.THREE` rather than letting every plugin bundle three.
  //
  // `rendererFor` is keyed by AudioContext, so a second plugin going through
  // this object shares the one worklet module load as well as the code.
  (window as never as { CrateXR?: unknown }).CrateXR ??= {
    createCrateAudio,
    resonantStoneMaterial,
    version: 1,
  };

  void (() => {
    let registered = false;

    const waitForRuntime = () =>
      new Promise<void>((resolve) => {
        const ready = () =>
          !!(window as never as { XRPublisher?: XRPublisherLike; THREE?: unknown }).XRPublisher &&
          !!(window as never as { THREE?: unknown }).THREE;
        if (ready()) {
          resolve();
          return;
        }
        let tries = 0;
        const iv = setInterval(() => {
          if (ready() || tries++ > 200) {
            clearInterval(iv);
            resolve();
          }
        }, 50);
      });

    const init = async () => {
      if (registered) return;
      await waitForRuntime();
      const XRPublisher = (window as never as { XRPublisher?: XRPublisherLike }).XRPublisher;
      const THREE = (window as never as { THREE?: Record<string, never> }).THREE;
      if (!XRPublisher || !THREE) {
        console.error(`[${PLUGIN_ID}] runtime not available`);
        return;
      }
      registered = true;

      // The listener is camera-mounted and appears when the player does, so
      // it is acquired in the background and never waited on.
      //
      // It used to be awaited here, with a ten-second cap, and a failure
      // returned early. That was wrong in a way that only showed up on a
      // phone: the early return skipped `registerDecoration`, so a slow
      // device got **no stones at all**, not silent ones. Registration is
      // cheap, unconditional and independent of audio, and the engine accepts
      // it at any time, so it happens first and the sound catches up.
      //
      // No attempt cap either. A cap is a promise that the listener will
      // appear within some window, and nothing about a phone loading terrain
      // over a mobile connection supports that promise.
      let listener: ThreeListenerLike | null = null;
      const acquireListener = () => {
        if (listener) return true;
        listener = XRPublisher.getAudioListener();
        if (listener) console.log(`[${PLUGIN_ID}] audio listener acquired`);
        return !!listener;
      };
      if (!acquireListener()) {
        const iv = setInterval(() => {
          if (acquireListener()) clearInterval(iv);
        }, 500);
        // A phone will not have an AudioContext at all until the player
        // touches the screen, so the first gesture is the likeliest moment
        // for one to exist. Cheap insurance next to a 500 ms poll.
        for (const event of ['pointerdown', 'touchend', 'keydown']) {
          window.addEventListener(event, () => acquireListener(), { passive: true });
        }
      }

      // Shared at module scope, per the engine's rules: `create()` runs once
      // per spawn and a geometry per stone is a geometry per stone.
      const Three = THREE as unknown as {
        IcosahedronGeometry: new (r: number, d: number) => never;
        MeshStandardMaterial: new (o: unknown) => {
          clone(): { emissiveIntensity: number; dispose(): void };
          dispose(): void;
        };
        Mesh: new (g: unknown, m: unknown) => Object3DLike & { scale: { setScalar(v: number): void } };
        Group: new () => Object3DLike;
      };

      const stoneGeometry = new Three.IcosahedronGeometry(0.55, 1);
      const baseMaterial = new Three.MeshStandardMaterial({
        color: 0x4a4f57,
        roughness: 0.85,
        metalness: 0.15,
        emissive: 0x2fd6c2,
        emissiveIntensity: 0,
        flatShading: true,
      });

      /** The last reason a voice could not be built, for `CrateXR.stats()`. */
      let lastVoiceError: string | null = null;

      /** Every mounted stone, by object identity. */
      interface Stone {
        object: Object3DLike;
        material: { emissiveIntensity: number; dispose(): void };
        params: Record<string, number>;
        position: { x: number; z: number };
        audio: CrateAudio | null;
        /** Set while `createCrateAudio` is in flight, so the pool does not start two. */
        claiming: boolean;
        stopAnalysis: (() => void) | null;
        level: number;
      }
      const live = new Set<Stone>();

      const distanceTo = (stone: Stone, px: number, pz: number) =>
        Math.hypot(stone.position.x - px, stone.position.z - pz);

      /** Wind at a stone, from the weather field, falling back to a light breeze. */
      const windAt = (stone: Stone): number => {
        const weather = XRPublisher.getWeatherAt?.(stone.position.x, stone.position.z);
        // `speed` is cloud drift, which is the closest thing the engine has to
        // a wind field; rain implies a blowing day. Both are optional.
        const speed = weather?.speed ?? 0.1;
        const rain = weather?.rain ?? 0;
        // The floor matters more than the slope. Fair weather is `speed` 0.1,
        // and a mapping without a base term made a calm hillside inaudible,
        // which reads as a broken plugin rather than as a quiet day. A stone
        // should always be doing something; weather is the difference between
        // humming and singing.
        return Math.max(0, Math.min(1, 0.42 + speed * 1.8 + rain * 0.4));
      };

      const giveVoice = async (stone: Stone) => {
        if (stone.audio || stone.claiming || !listener) return;
        stone.claiming = true;
        try {
          const audio = await createCrateAudio(
            listener,
            resonantStoneMaterial,
            {
              params: { ...stone.params, wind: windAt(stone) },
              volume: 0,
              // Without this the panner's refDistance is 1 and a stone six
              // paces away is at a sixth of its level. The stones are
              // object-sized sources on open ground, so: full level close up,
              // clearly there across a clearing, gone by the pool's radius.
              spatial: { refDistance: 7, rolloffFactor: 1.1, maxDistance: AUDIBLE_RADIUS },
            },
            THREE as never,
          );
          // The stone may have been unmounted while the worklet was loading.
          if (!live.has(stone)) {
            audio.dispose();
            return;
          }
          stone.object.add(audio.audio);
          stone.audio = audio;
          // Fade in rather than appearing at full level: a stone that snaps
          // on as you cross a radius is a click, and the whole reason for the
          // pool is that stones come and go as you walk.
          audio.rampVolume(1, 0.6);
          stone.stopAnalysis = audio.onAnalysis((frame) => {
            stone.level = frame.meters.stone?.peak ?? 0;
          }, 15);
        } catch (error) {
          lastVoiceError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          // Leave nothing half-attached. `stone.audio` is assigned before the
          // fade-in, so an error after that point used to leave a stone that
          // the pool considered voiced and that never made a sound: silent
          // forever, and silent in a way that looks like bad DSP rather than
          // a thrown exception. Clearing it lets the next pool tick retry.
          console.warn(`[${PLUGIN_ID}] voice failed`, error);
          try {
            stone.audio?.dispose();
          } catch {
            // Already broken; nothing further to salvage.
          }
          stone.audio = null;
          stone.stopAnalysis = null;
        } finally {
          stone.claiming = false;
        }
      };

      const takeVoice = (stone: Stone) => {
        // `finally`, so the bookkeeping clears even if teardown throws. It
        // did: a throw here left `stone.audio` set, so the pool believed the
        // stone still held a voice and tried to release it again on every
        // tick, forever.
        try {
          stone.stopAnalysis?.();
          // Unparent as well as disconnect. `giveVoice` adds a fresh
          // PositionalAudio to the mesh every time a voice is granted, so a
          // stone the player walks past repeatedly would otherwise collect a
          // dead audio child per pass, each one still in the scene graph and
          // still being matrix-updated.
          if (stone.audio) stone.object.remove(stone.audio.audio);
          stone.audio?.dispose();
        } catch (error) {
          console.warn(`[${PLUGIN_ID}] release failed`, error);
        } finally {
          stone.stopAnalysis = null;
          stone.audio = null;
          stone.level = 0;
          stone.material.emissiveIntensity = 0;
        }
      };

      /**
       * Re-decides which stones are audible. Runs on an interval rather than
       * in `update`, because `update` runs per stone per frame and this is a
       * decision about all of them together.
       */
      const runPool = () => {
        // No listener yet: the stones exist and are visible, they just have
        // nothing to speak through. Checked here rather than by not starting
        // the timer, because the listener can arrive at any point.
        if (!listener) return;
        const player = XRPublisher.getPlayerState();
        if (!player) return;

        const ranked = [...live]
          .map((stone) => ({ stone, distance: distanceTo(stone, player.x, player.z) }))
          .filter((entry) => entry.distance <= AUDIBLE_RADIUS)
          .sort((a, b) => a.distance - b.distance)
          .slice(0, MAX_VOICES);

        // Releases first, so the voice budget is free before anything asks
        // for it. Each stone is isolated: one failing to let go of its voice
        // must not stop every other stone from getting one, which is exactly
        // what happened when a throw here escaped and aborted the pass before
        // it reached the allocation loop below. One stone went quiet and the
        // whole world stayed quiet after it.
        const keep = new Set(ranked.map((entry) => entry.stone));
        for (const stone of live) {
          if (stone.audio && !keep.has(stone)) takeVoice(stone);
        }
        for (const { stone } of ranked) {
          try {
            if (!stone.audio) void giveVoice(stone);
            else stone.audio.set('wind', windAt(stone));
          } catch (error) {
            console.warn(`[${PLUGIN_ID}] pool tick failed for a stone`, error);
          }
        }
      };
      const poolTimer = setInterval(runPool, POOL_INTERVAL_MS);
      // Nothing unregisters this plugin at runtime. Clear the interval on
      // navigation so it does not keep ticking after the page is gone.
      window.addEventListener('pagehide', () => clearInterval(poolTimer), { once: true });

      XRPublisher.registerDecoration({
        name: 'crate-resonant-stone',
        density: 1.6,
        minSpacing: 11,
        minHeight: 0.5,
        maxHeight: 0.72,
        maxSlope: 0.4,
        surface: ['grass', 'dirt', 'rock'],
        collision: 'cuboid',
        interactable: true,
        interactionPrompt: 'Strike the stone',
        interactionRadius: 3.5,

        create(spawn: Spawn) {
          // Everything that makes this stone itself comes from the seeded
          // PRNG, so the hillside is the same hillside for everyone.
          const degree = SCALE[Math.floor(spawn.rng() * SCALE.length)]!;
          const octave = Math.floor(spawn.rng() * 3);
          const size = 0.7 + spawn.rng() * 1.5;

          const material = baseMaterial.clone();
          const mesh = new Three.Mesh(stoneGeometry, material);
          mesh.scale.setScalar(size);

          const stone: Stone = {
            object: mesh,
            material,
            // A bigger stone is lower and duller, which is the one place the
            // visual and the sound have to agree or the illusion goes.
            params: {
              pitch: (ROOT_HZ * Math.pow(2, degree / 12 + octave)) / size,
              brightness: Math.max(0.1, 1 - (size - 0.7) / 1.5) * (0.5 + spawn.rng() * 0.5),
              ring: 18 + spawn.rng() * 55,
              grain: 260 + spawn.rng() * 1800,
              grainRatio: 1.4 + spawn.rng() * 3.2,
            },
            position: { x: spawn.renderPosition[0], z: spawn.renderPosition[2] },
            audio: null,
            claiming: false,
            stopAnalysis: null,
            level: 0,
          };
          mesh.userData.crateStone = stone;
          live.add(stone);
          return mesh;
        },

        /**
         * Per stone, per frame: the pool does the allocation on its own
         * interval. The glow follows the meter here because it has to update
         * every frame.
         */
        update(object: Object3DLike) {
          const stone = object.userData.crateStone as Stone | undefined;
          if (!stone) return;
          const target = stone.audio ? Math.min(1, stone.level * 6) : 0;
          // Asymmetric smoothing: bright fast, dark slow, which is what a
          // ringing object looks like and what a plain lerp does not.
          const rate = target > stone.material.emissiveIntensity ? 0.5 : 0.06;
          stone.material.emissiveIntensity += (target - stone.material.emissiveIntensity) * rate;
        },

        onInteract(ctx: { object: Object3DLike }) {
          const stone = ctx.object.userData.crateStone as Stone | undefined;
          // `strike`, not `noteOn`. A gated voice is already high, and every
          // ASL trigger fires on a rising edge, so a bare `noteOn` rings the
          // stone once and then never again for the life of that voice. See
          // `CrateAudio.strike`.
          //
          // A stone with no voice is outside the pool, so there is nothing
          // to strike. The interact radius and the voice radius are not
          // guaranteed to match.
          stone?.audio?.strike({ velocity: 0.85 });
        },

        dispose(object: Object3DLike) {
          const stone = object.userData.crateStone as Stone | undefined;
          if (stone) {
            // Guarded by identity, not by seed: a chunk re-scatter creates
            // the new object before disposing the old one, and deleting by
            // seed would drop the stone that is actually in the world.
            takeVoice(stone);
            live.delete(stone);
            stone.material.dispose();
          }
          // The geometry is shared, so the engine's default deep dispose
          // would free it out from under every other stone.
        },
      });

      // A one-call answer to "why can I not hear anything", because the
      // alternative is another round of pasting console logs at each other.
      // Reports the four things that have actually gone wrong so far: no
      // stones, no listener, no voices, or voices that are simply far away.
      (window as never as { CrateXR: Record<string, unknown> }).CrateXR.stats = () => {
        const player = XRPublisher.getPlayerState();
        const stones = [...live].map((stone) => ({
          x: Math.round(stone.position.x),
          z: Math.round(stone.position.z),
          distance: player
            ? Math.round(distanceTo(stone, player.x, player.z))
            : null,
          voiced: !!stone.audio,
          wind: Number(windAt(stone).toFixed(2)),
          pitch: Math.round(stone.params.pitch!),
        }));
        stones.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
        const report = {
          stonesMounted: stones.length,
          listener: !!listener,
          audioContextState: listener?.context.state ?? 'none',
          voiceBudget: MAX_VOICES,
          lastVoiceError,
          workletUrl: listener
            ? (rendererFor(listener.context).loadedWorkletUrl ?? 'none loaded').slice(0, 60)
            : 'no listener',
          voicesLive: stones.filter((s) => s.voiced).length,
          audibleRadius: AUDIBLE_RADIUS,
          player: player ? { x: Math.round(player.x), z: Math.round(player.z) } : null,
          nearest: stones.slice(0, 5),
        };
        console.table(report.nearest);
        return report;
      };

      console.log(
        `[${PLUGIN_ID}] ready: crate AudioMaterials on THREE.PositionalAudio ` +
          `(voice budget ${MAX_VOICES}). Run CrateXR.stats() to diagnose.`,
      );
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
    else setTimeout(() => void init(), 300);
  })();
}
