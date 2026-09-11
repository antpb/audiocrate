/**
 * Proves the shipped plugin file works, in a browser, against a
 * audio thread.
 *
 * Not the source: `dist/crate-stones-xr-publisher-plugin.umd.js`, the exact
 * bytes that get copied into a worlds API. That distinction is the point of
 * this check, because the two things most likely to be wrong are both
 * properties of the bundle rather than of the code:
 *
 *   - the worklet is inlined as a blob URL, and a blob URL that
 *     `audioWorklet.addModule` refuses fails at runtime with a network error
 *     that names nothing;
 *   - a plugin that accidentally bundled three would break `instanceof` in a
 *     world and work perfectly in every unit test.
 *
 * The engine is faked rather than run. Standing up a whole XR Publisher world
 * would test the engine, which is not what is uncertain here; what is
 * uncertain is whether crate's audio survives being squeezed into one file.
 * So this supplies the four things the plugin actually asks the engine for
 * and drives the decoration by hand.
 *
 *   node scripts/check-plugin.mjs
 */
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, '../dist/crate-stones-xr-publisher-plugin.umd.js');
const bundle = readFileSync(bundlePath, 'utf8');

// Served rather than injected, because a blob: worklet URL inherits the
// document's origin and `about:blank` is not one an AudioWorklet will load
// from.
const server = createServer((req, res) => {
  if (req.url?.startsWith('/plugin.js')) {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(bundle);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta charset="utf-8"><title>crate-stones check</title>');
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// WebKit on request: the closest thing to iOS Safari that runs headless, and
// the engine family where an AudioWorklet is most likely to differ.
const engine = process.argv[2] === 'webkit' ? 'webkit' : 'chromium';
const browser =
  engine === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`engine: ${engine} ${browser.version()}`);
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.stack || e}`));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

// The fake engine, installed before the plugin so its bootstrap finds it.
await page.evaluate(() => {
  const decorations = [];
  window.__decorations = decorations;
  window.__player = { x: 0, y: 0, z: 0 };
  window.__listenerContext = null;
  window.__withholdListener = true;

  // Just enough THREE. `PositionalAudio` is the object under test on the
  // three.js side: everything this plugin does to make a sound audible goes
  // through `setNodeSource`, which is the seam the whole bridge rests on.
  // Modelled on the real class, which matters more than it looks. three.js
  // `Audio` owns a GainNode at `.gain` and returns it from `getOutput()`;
  // `PositionalAudio` inserts a PannerNode and **overrides `getOutput()` to
  // return the panner instead**. A fake that returns a gain node from
  // `getOutput()` is not a simplification, it is a different class, and it
  // hid a crash that made every stone in the world silent.
  //
  //   source -> panner -> gain -> listener -> destination
  class FakeAudio {
    constructor(listener, positional) {
      this.listener = listener;
      const ctx = listener.context;
      this.gain = ctx.createGain();
      this.panner = positional ? ctx.createPanner() : null;
      if (this.panner) this.panner.connect(this.gain);
      // Real `THREE.Audio` ends at the listener's gain, which ends at the
      // destination. Leaving this dangling is not harmless either: Web Audio
      // does not pull a graph nothing downstream consumes, so the worklet's
      // `process` never runs and the check reads silence from a working
      // plugin.
      this.gain.connect(ctx.destination);
      this.sourceNode = null;
      this.connected = false;
    }
    getOutput() {
      return this.panner ?? this.gain;
    }
    setNodeSource(node) {
      this.sourceNode = node;
      node.connect(this.getOutput());
      this.connected = true;
      return this;
    }
    setVolume(v) {
      this.gain.gain.value = v;
      return this;
    }
    setRefDistance(v) {
      if (!this.panner) return this;
      this.panner.refDistance = v;
      return this;
    }
    setRolloffFactor(v) {
      if (this.panner) this.panner.rolloffFactor = v;
      return this;
    }
    setMaxDistance(v) {
      if (this.panner) this.panner.maxDistance = v;
      return this;
    }
    setDistanceModel(v) {
      if (this.panner) this.panner.distanceModel = v;
      return this;
    }
    // Copied from three's Audio.js, not approximated. It is a **targeted**
    // disconnect of the source from `getOutput()`, and Web Audio throws
    // InvalidAccessError if that specific edge is already gone. Disconnecting
    // the gain node instead, as this fake used to, is a different operation
    // that cannot fail, which is precisely why it hid a crash.
    disconnect() {
      if (this.connected === false) return this;
      this.sourceNode.disconnect(this.getOutput());
      this.connected = false;
      return this;
    }
  }
  class FakeObject3D {
    constructor() {
      this.children = [];
      this.userData = {};
      this.scale = { setScalar: () => {} };
    }
    add(child) {
      this.children.push(child);
    }
    remove(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
    }
    traverse(fn) {
      fn(this);
    }
  }

  window.THREE = {
    Audio: class extends FakeAudio {
      constructor(l) {
        super(l, false);
      }
    },
    PositionalAudio: class extends FakeAudio {
      constructor(l) {
        super(l, true);
      }
    },
    Mesh: class extends FakeObject3D {},
    Group: class extends FakeObject3D {},
    IcosahedronGeometry: class {
      dispose() {}
    },
    MeshStandardMaterial: class {
      constructor(o) {
        Object.assign(this, o);
      }
      clone() {
        return new window.THREE.MeshStandardMaterial(this);
      }
      dispose() {
        this.disposed = true;
      }
    },
  };

  window.XRPublisher = {
    registerDecoration: (spec) => decorations.push(spec),
    getAudioListener: () => {
      // Withheld until the test says otherwise, standing in for a phone where
      // the camera listener mounts late or waits on a touch.
      if (window.__withholdListener) return null;
      if (!window.__listenerContext) {
        window.__listenerContext = new AudioContext();
        // The engine resumes the shared context on the first user gesture.
        void window.__listenerContext.resume();
      }
      return { context: window.__listenerContext };
    },
    getPlayerState: () => window.__player,
    getWeatherAt: () => ({ speed: 0.4, rain: 0 }),
  };
});

await page.addScriptTag({ url: '/plugin.js' });

const result = await page.evaluate(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The bootstrap waits 300ms then polls; give it room.
  for (let i = 0; i < 100 && window.__decorations.length === 0; i++) await sleep(50);
  out.registered = window.__decorations.map((d) => d.name);
  if (!window.__decorations.length) return out;

  // Phase one: no listener at all, the way a phone looks for the first few
  // seconds (or forever, if it never gets a gesture). Stones are visual
  // objects and must exist regardless. This is the check that was missing:
  // the plugin used to wait ten seconds for a listener and then return
  // BEFORE registering, so a slow device got no stones at all, not silent
  // ones, and the symptom was "I cannot see it on mobile".
  out.registeredWithoutListener = window.__decorations.length > 0;

  const spec = window.__decorations[0];
  out.interactable = spec.interactable === true;
  out.hasUpdate = typeof spec.update === 'function';
  out.hasDispose = typeof spec.dispose === 'function';

  // A deterministic stand-in for the engine's seeded PRNG, so this check does
  // not depend on Math.random any more than the plugin does.
  let s = 12345;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const meshWithoutAudio = spec.create({
    rng,
    seed: 'check-seed-silent',
    renderPosition: [4, 0, 0],
    normalizedHeight: 0.55,
    surface: 'grass',
  });
  out.meshWithoutListener = !!meshWithoutAudio;
  // The pool must survive ticking with nothing to speak through.
  await sleep(600);
  out.survivedNoListener = window.__decorations.length > 0;

  // Now let the listener appear, as it would on the first touch.
  window.__withholdListener = false;

  const mesh = spec.create({
    rng,
    seed: 'check-seed',
    renderPosition: [2, 0, 0],
    normalizedHeight: 0.55,
    surface: 'grass',
  });
  out.created = !!mesh;
  const stone = mesh.userData.crateStone;
  out.stoneParams = stone ? Object.keys(stone.params).sort() : null;

  // The pool runs on its own 250ms interval and the player is standing next
  // to the stone, so a voice should arrive without anything else happening.
  for (let i = 0; i < 80 && !stone.audio; i++) await sleep(50);
  out.gotVoice = !!stone.audio;
  if (!stone.audio) return out;

  out.sourceIsWorklet = stone.audio.audio.sourceNode instanceof AudioWorkletNode;
  out.connectedToThree = stone.audio.audio.connected === true;
  out.mountedOnStone = mesh.children.includes(stone.audio.audio);

  // Does it actually make a sound? Read the analysis tap the glow uses: it
  // is measured inside the graph, on the audio thread, so a nonzero peak
  // means the fused ASL graph really ran.
  stone.audio.set('wind', 1);
  let peak = 0;
  let frameCount = 0;
  const off = stone.audio.onAnalysis((frame) => {
    frameCount += 1;
    peak = Math.max(peak, frame.meters.stone?.peak ?? 0);
  }, 30);
  await sleep(1200);
  off();
  out.meterPeak = peak;
  out.analysisFrames = frameCount;

  // And through the graph's actual output, independently of the tap.
  const ctx = window.__listenerContext;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  stone.audio.audio.gain.connect(analyser);
  // Deliberately NOT setting the volume here. The plugin fades each stone in
  // with `rampVolume` and creates it at zero, so measuring after a manual
  // `setVolume` would prove the graph runs while saying nothing about whether
  // the plugin ever made it audible. It did not, once.
  await sleep(700);
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  out.outputRms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);

  // Striking it should be louder than not striking it.
  const before = peak;
  spec.onInteract({ object: mesh });
  let struck = 0;
  const off2 = stone.audio.onAnalysis((frame) => {
    struck = Math.max(struck, frame.meters.stone?.peak ?? 0);
  }, 30);
  await sleep(500);
  off2();
  out.strikePeak = struck;
  out.strikeLouder = struck > before;

  // Strike it AGAIN. This is the assertion that was missing, and its absence
  // hid a bug that let each stone ring exactly once for the life of its
  // voice: `noteOn` latches the gate high, and every ASL trigger fires on a
  // rising edge, so the second press did nothing at all. Striking once and
  // calling it proven is how that shipped twice.
  await sleep(700);
  let struckAgain = 0;
  const off4 = stone.audio.onAnalysis((frame) => {
    struckAgain = Math.max(struckAgain, frame.meters.stone?.peak ?? 0);
  }, 30);
  spec.onInteract({ object: mesh });
  await sleep(600);
  off4();
  out.secondStrikePeak = struckAgain;

  // And the audio object must not accumulate on the mesh across voice cycles.
  out.audioChildren = mesh.children.length;

  // Panner distances are set, or everything is inaudible past a few paces.
  out.refDistance = stone.audio.audio.panner?.refDistance ?? 0;

  // Walking away must return the voice to the pool. This is the one that
  // stops forty abandoned worklets accumulating on the audio thread.
  window.__player = { x: 5000, y: 0, z: 5000 };
  for (let i = 0; i < 40 && stone.audio; i++) await sleep(50);
  out.voiceReleased = !stone.audio;

  // ...and walking back must give it one again. Releasing a voice runs
  // teardown code that a first-time allocation never touches, so a pool that
  // dies on its first release looks perfect until the moment you walk away
  // from the first stone you found.
  window.__player = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 80 && !stone.audio; i++) await sleep(50);
  out.reacquired = !!stone.audio;

  let secondPeak = 0;
  if (stone.audio) {
    const off3 = stone.audio.onAnalysis((frame) => {
      secondPeak = Math.max(secondPeak, frame.meters.stone?.peak ?? 0);
    }, 30);
    stone.audio.set('wind', 1);
    await sleep(800);
    off3();
  }
  out.soundsAgain = secondPeak;

  // The bridge is published for other plugins to reuse.
  out.bridgePublished = typeof window.CrateXR?.createCrateAudio === 'function';
  return out;
});

await browser.close();
server.close();

const failures = [];
const expect = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
};

expect('decoration registered', result.registered?.includes('crate-resonant-stone'), JSON.stringify(result.registered));
expect('registers before any AudioListener exists', result.registeredWithoutListener);
expect('creates visible stones with no listener', result.meshWithoutListener);
expect('pool survives having no listener', result.survivedNoListener);
expect('spec is interactable', result.interactable);
expect('spec has update and dispose', result.hasUpdate && result.hasDispose);
expect('create() built a stone', result.created);
expect('voice was allocated by the pool', result.gotVoice);
expect('source is an AudioWorkletNode', result.sourceIsWorklet);
expect('wired into the three.js audio object', result.connectedToThree);
expect('mounted on the stone object', result.mountedOnStone);
expect('the graph made sound', result.meterPeak > 0.0005, `meter peak ${result.meterPeak}`);
expect('output reached the three.js gain', result.outputRms > 0.0001, `rms ${result.outputRms}`);
expect('striking is louder', result.strikeLouder, `${result.strikePeak} vs ${result.meterPeak}`);
expect(
  'striking a SECOND time still rings',
  result.secondStrikePeak > result.meterPeak * 2,
  `second strike ${result.secondStrikePeak} vs ambient ${result.meterPeak}`,
);
expect('panner refDistance was set', result.refDistance > 1, `refDistance ${result.refDistance}`);
expect('one audio object on the mesh, not one per voice', result.audioChildren === 1, `${result.audioChildren} children`);
expect('voice released on walking away', result.voiceReleased);
expect('voice re-acquired on walking back', result.reacquired);
expect('still makes sound the second time', result.soundsAgain > 0.0005, `peak ${result.soundsAgain}`);
expect('bridge published for other plugins', result.bridgePublished);
// The plugin catches its own errors so a broken stone does not take the world
// down with it. That is right, and it means a fatal bug reaches the user as a
// console line and a silent world, so the check has to read the console.
const complaints = logs.filter((line) => /crate-stones/.test(line) && /voice failed|error|warn/i.test(line));
expect('plugin logged no failures', complaints.length === 0, complaints.join(' | '));

console.log('\n=== crate-stones, shipped bundle, real browser ===');
for (const [key, value] of Object.entries(result)) {
  console.log(`  ${key.padEnd(20)} ${typeof value === 'number' ? value.toFixed(6) : JSON.stringify(value)}`);
}
if (failures.length) {
  console.error('\nFAILED:');
  for (const line of failures) console.error(`  ${line}`);
  console.error('\npage log:');
  for (const line of logs) console.error(`  ${line}`);
  process.exit(1);
}
console.log('\nall checks passed');
