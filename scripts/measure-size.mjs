/**
 * Measures what a consumer actually downloads, per entry point.
 *
 * ## Why this is a script and not a number in the README
 *
 * The README used to carry three sizes with no record of what was imported to
 * get them. When the worklet grew, there was no way to tell whether the
 * numbers had moved or whether the next person to measure was simply
 * importing something different. A size claim nobody can reproduce is a
 * number that quietly goes wrong.
 *
 * So the entry points live here, in `PROFILES`, and the README quotes this
 * script's output. Re-run it after anything that changes what a barrel pulls
 * in, and paste the table.
 *
 * ## Method
 *
 * Packs the real tarball, installs it into a throwaway project, and bundles
 * each entry with esbuild and no plugins. That is a consumer's build, not a
 * measurement of the repo: the `exports` map, `sideEffects: false` and the
 * published `dist` all get a say, and the in-repo suite is blind to every one
 * of them.
 *
 * Run with `node scripts/measure-size.mjs` from this package.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each profile is a realistic shape of app, not a minimal import that would
 * flatter the number. "Theory only" is a music-theory tool with no audio;
 * "offline" is a renderer or an analysis job; "real time" is a full player.
 */
const PROFILES = [
  {
    label: '`audiocrate/theory` alone',
    note: 'a theory tool with no audio at all',
    source: `import { midiFromName, midiToFrequency, scaleNotes, chordNotes } from 'audiocrate/theory';
globalThis.out = [midiFromName('A4'), midiToFrequency(69), scaleNotes, chordNotes];`,
  },
  {
    label: 'Scene graph plus offline rendering',
    note: 'bounce and analysis, never plays live',
    source: `import { AudioScene, OfflineRenderer, osc, env, Material } from 'audiocrate';
globalThis.out = [AudioScene, OfflineRenderer, osc, env, Material];`,
  },
  {
    label: 'Everything including real-time audio',
    note: 'a full player: voices, worklet, spatial',
    source: `import { AudioScene, WebAudioRenderer, SpatialBus, crateWorkletUrls, osc, env, Material } from 'audiocrate';
globalThis.out = [AudioScene, WebAudioRenderer, SpatialBus, crateWorkletUrls, osc, env, Material];`,
  },
];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const dir = mkdtempSync(join(tmpdir(), 'audiocrate-size-'));
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', dir], pkg));
  const tarball = join(dir, packed[0].filename);

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'size', private: true, type: 'module' }));
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', tarball], dir);

  const rows = [];
  for (const profile of PROFILES) {
    const entry = join(dir, `${rows.length}.mjs`);
    writeFileSync(entry, profile.source);
    const out = `${entry}.bundle.js`;
    run('npx', ['--yes', 'esbuild@0.25.12', entry, '--bundle', '--minify',
      '--format=esm', '--platform=browser', `--outfile=${out}`, '--log-level=error'], dir);
    rows.push({ ...profile, bytes: statSync(out).size });
  }

  const worklet = readFileSync(join(pkg, 'dist/crate-voice-processor.js'), 'utf8').length;
  const kb = (n) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;

  process.stdout.write(`\ntarball: ${kb(packed[0].size)}, ${packed[0].entryCount} files\n`);
  process.stdout.write(`worklet: ${kb(worklet)} (a string constant, so minifying does not shrink it)\n\n`);
  process.stdout.write('| What you import | Bundled |\n|---|---|\n');
  for (const row of rows) process.stdout.write(`| ${row.label} | ${kb(row.bytes)} |\n`);
  process.stdout.write('\n');
  for (const row of rows) process.stdout.write(`  ${kb(row.bytes).padStart(8)}  ${row.note}\n`);
  process.stdout.write('\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
