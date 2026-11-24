/**
 * hc_dynEQ and hc_send on the web: the ported kernel (dsp/dyneq_kernel.cpp
 * in WASM) and the envelope bus between them. Needs wasm/build_dyneq.sh.
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dyneqKernelFactory, sendKernelFactory } from './kernel';
import { dyneqParams } from './params';
import { dyneqPlugin, sendPlugin, envelopeBusTracks } from './plugin';
import { AU_TYPE_EFFECT, AU_TYPE_MUSIC_EFFECT, AudioMaterialRegistry, mapPluginSlot } from './crate';

const SR = 48000;
const WASM = new URL('../wasm/dist/dyneq.wasm', import.meta.url);
const wasm = () => fs.readFileSync(WASM).buffer.slice(0) as ArrayBuffer;
const g = globalThis as unknown as { currentTime: number };
const defaults = () => Object.fromEntries(Object.entries(dyneqParams).map(([k, d]) => [k, d.default]));

function sine(freq: number, amp: number, from: number) {
  return Float32Array.from({ length: 128 }, (_, i) => amp * Math.sin((2 * Math.PI * freq * (from + i)) / SR));
}

async function dyneq(params: Record<string, number>) {
  const k = (await dyneqKernelFactory(SR, { wasm: wasm() }))!;
  k.applyParams!({ ...defaults(), ...params });
  return k;
}

/** Renders `seconds` of a tone through `k`, returning the peak of the last 0.1 s. */
function run(k: Awaited<ReturnType<typeof dyneq>>, freq: number, seconds: number, each?: (block: number) => void) {
  const blocks = Math.round((seconds * SR) / 128);
  const tail = Math.round((0.1 * SR) / 128);
  let peak = 0;
  for (let b = 0; b < blocks; b++) {
    each?.(b);
    const input = sine(freq, 0.25, b * 128);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    k.processSource!(input, input, l, r);
    g.currentTime += 128 / SR;
    if (b >= blocks - tail) for (const v of l) peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

describe.skipIf(!fs.existsSync(WASM))('hc_dynEQ', () => {
  afterEach(() => {
    g.currentTime = 0;
  });

  it('maps both of the AU registrations and hc_send', () => {
    const registry = new AudioMaterialRegistry().registerAll([dyneqPlugin, sendPlugin]);
    const slot = (type: number, sub: number) => mapPluginSlot({ componentType: type, componentSubType: sub, componentManufacturer: 0x4e414d70 }, null, registry);
    expect(slot(AU_TYPE_EFFECT, 0x64796571).kind).toBe('dyneq');
    expect(slot(AU_TYPE_MUSIC_EFFECT, 0x64796571).kind).toBe('dyneq');
    expect(slot(AU_TYPE_EFFECT, 0x73656e64).kind).toBe('send');
  });

  it('passes audio through untouched at its defaults, after the fade-in', async () => {
    const k = await dyneq({});
    for (let b = 0; b < 10; b++) k.processSource!(sine(440, 0.3, b * 128), null, new Float32Array(128), new Float32Array(128));
    const input = sine(440, 0.3, 1280);
    const out = new Float32Array(128);
    k.processSource!(input, null, out, new Float32Array(128));
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('boosts a band by its gain at the band centre', async () => {
    const k = await dyneq({ eqBand3: 6.0206 });
    expect(run(k, 3500, 0.5) / 0.25).toBeCloseTo(2, 1);
  });

  it('ducks a band by its depth while a send plays at full scale, and lets go when it stops', async () => {
    const send = (await sendKernelFactory(SR, {}))!;
    send.applyParams!({ sendLevel: 1 });
    const k = await dyneq({ duckDepth2: -12, duckAttack: 5, duckRelease: 50 });
    const kick = new Float32Array(128).fill(1);
    const pushSend = () => send.processSource!(kick, kick, new Float32Array(128), new Float32Array(128));
    const ducked = run(k, 1200, 0.5, pushSend);
    expect(20 * Math.log10(ducked / 0.25)).toBeCloseTo(-12, 0);
    // The send stops rendering: after 150 ms it is stale, and the duck releases.
    const back = run(k, 1200, 1);
    expect(20 * Math.log10(back / 0.25)).toBeCloseTo(0, 0);
    send.dispose!();
  });

  it('compresses and makes up as the AU does with this song\'s settings', async () => {
    // Track 2's dynEQ in "November 22 Song": thresh -12.8, makeup +8, EQ lifts.
    const k = await dyneq({ eqBand2: 2.12, eqBand3: 6.82, eqBand4: 3.616, compThresh: -12.781, compMakeup: 7.951 });
    const out = run(k, 1000, 1);
    expect(out).toBeGreaterThan(0.25 * 1.5); // louder than in, by a lot: the layer the web was missing
  });

  it('keeps the dynEQ and send tracks together only when a send exists', () => {
    const t = (...kinds: string[]) => ({ materials: { list: kinds.map((kind) => ({ kind })) } });
    const pad = t('dyneq');
    const kick = t('send');
    expect(envelopeBusTracks([pad, t()]).size).toBe(0);
    expect([...envelopeBusTracks([pad, kick, t()])]).toEqual([pad, kick]);
  });
});
