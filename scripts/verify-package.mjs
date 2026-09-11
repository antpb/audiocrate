/**
 * Packs the package, installs it into a throwaway project outside this
 * repository, and uses it the way a stranger would.
 *
 * ## Why this is not just another vitest file
 *
 * Everything vitest runs imports `src/`, through a resolver this repository
 * configures, with TypeScript checking every call. A published package has
 * none of those advantages: it is built output, resolved by whatever bundler
 * the consumer chose, imported through `exports`, and called from plain
 * JavaScript where a wrong option name is not a compile error.
 *
 * Every class of bug that lives in that gap is invisible to the unit tests by
 * construction. Writing this file found two immediately:
 *
 * - `WebAudioRenderer` imported its worklet through Vite plugin syntax, so
 *   the package could not be built by anything else.
 * - `env.adsr` rendered an unbroken stream of NaN when called with the same
 *   option names its sibling `env.dahdsr` uses. TypeScript made that
 *   unreachable from inside this repository; a JavaScript caller got silence.
 *
 * Run it before publishing. It takes about fifteen seconds.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const workspace = mkdtempSync(join(tmpdir(), 'audiocrate-verify-'));
let ok = false;
try {
  process.stdout.write(`building and packing ${pkg}\n`);
  run('npm', ['run', 'build'], pkg);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', workspace], pkg));
  const tarball = join(workspace, packed[0].filename);
  process.stdout.write(`  ${packed[0].filename}  ${(packed[0].size / 1024).toFixed(0)} KB, ${packed[0].entryCount} files\n\n`);

  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2));
  process.stdout.write('installing into a clean project\n');
  run('npm', ['install', tarball], workspace);

  // Plain JavaScript on purpose: this is the surface TypeScript was hiding.
  writeFileSync(
    join(workspace, 'consumer.mjs'),
    `import {
  AudioScene, Track, AudioMaterial, param, filter, osc, env, Time,
  OfflineRenderer, describeAudioMaterial, crateWorkletUrls, CRATE_WORKLET_SOURCE,
} from 'audiocrate';
import { detectChord, noteName } from 'audiocrate/theory';
import { encodeWavFloat32 } from 'audiocrate/testing';

let bad = 0;
const check = (pass, msg) => { console.log(\`   \${pass ? 'ok  ' : 'FAIL'} \${msg}\`); if (!pass) bad++; };

const bell = new AudioMaterial({
  name: 'Bell',
  params: {
    pitch: param.range(50, 2000, { default: 440, unit: 'Hz' }),
    cutoff: param.range(200, 12000, { default: 3000, unit: 'Hz' }),
  },
  graph: ({ params }) =>
    filter.lowpass(
      osc({ freq: params.pitch, type: 'sine' })
        .mul(env.adsr({ attack: 0.005, decay: 0.4, sustain: 0, release: 0.1 }).trigger(1)),
      { cutoff: params.cutoff },
    ),
});
console.log('1. an AudioMaterial defined entirely in userland');
check(bell.name === 'Bell', \`"\${bell.name}" with params [\${Object.keys(bell.snapshotParams())}]\`);

console.log('2. it describes its own control panel');
const panel = describeAudioMaterial(bell);
check(panel.controls.length === 2, panel.controls.map((c) => \`\${c.label} (\${c.kind})\`).join(', '));

console.log('3. it renders real audio offline');
const { samples, sampleRate } = OfflineRenderer.render(bell.graph, {
  duration: 0.5, sampleRate: 48000, params: { pitch: 440, cutoff: 3000 },
});
let peak = 0;
for (const v of samples) { if (Number.isNaN(v)) { peak = NaN; break; } peak = Math.max(peak, Math.abs(v)); }
check(samples.length === 24000, \`\${samples.length} samples @ \${sampleRate} Hz\`);
check(peak > 0.001, \`peak \${Number.isNaN(peak) ? 'NaN (the graph produced NaN)' : peak.toFixed(5)}\`);
const head = samples.slice(0, 2400).reduce((a, s) => a + s * s, 0);
const tail = samples.slice(-2400).reduce((a, s) => a + s * s, 0);
check(head > tail * 10, 'the envelope actually decays');

console.log('4. the worklet ships with no bundler help');
const urls = crateWorkletUrls();
check(CRATE_WORKLET_SOURCE.length > 40000, \`\${(CRATE_WORKLET_SOURCE.length / 1024).toFixed(1)} KB of self-contained DSP\`);
check(urls.length >= 2, \`\${urls.length} delivery URLs\`);

console.log('5. subpath exports resolve');
check(noteName(60) === 'C4', \`theory: noteName(60)=\${noteName(60)}, detectChord([60,64,67])=\${detectChord([60,64,67])?.symbol}\`);
check(typeof encodeWavFloat32 === 'function', 'testing: encodeWavFloat32');

console.log('6. the scene graph works');
const scene = new AudioScene();
const track = scene.addTrack(new Track({ name: 'Guitar' }));
track.materials.add(bell);
check(scene.tracks.length === 1, \`one track named "\${track.name}"\`);
check(Time.bars(2, 1, 0) != null, 'Time.bars(2,1,0)');

process.exit(bad ? 1 : 0);
`,
  );

  process.stdout.write('\nusing it as a stranger would\n');
  process.stdout.write(run('node', ['consumer.mjs'], workspace));

  // Bundling with something that is not Vite, which is the whole point of
  // shipping the worklet as a string.
  process.stdout.write('\nbundling a consumer app with esbuild (no plugins)\n');
  writeFileSync(
    join(workspace, 'app.mjs'),
    "import { WebAudioRenderer, AudioMaterial, osc } from 'audiocrate';\n" +
      "export const m = new AudioMaterial({ name: 'x', params: {}, graph: () => osc({ freq: 440, type: 'saw' }) });\n" +
      'export const make = (ctx) => new WebAudioRenderer(ctx);\n',
  );
  run('npx', ['--yes', 'esbuild@0.25.12', 'app.mjs', '--bundle', '--format=esm',
    '--platform=browser', '--minify', `--outfile=${join(workspace, 'bundle.js')}`], workspace);
  process.stdout.write('   ok   esbuild bundled it with no plugin\n');

  ok = true;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(ok ? '\nPACKAGE VERIFIED\n' : '\nPACKAGE VERIFICATION FAILED\n');
process.exit(ok ? 0 : 1);
