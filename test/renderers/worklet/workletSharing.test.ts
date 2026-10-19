/**
 * One worklet per AudioContext, however many renderers or package copies ask.
 *
 * Found by XR Publisher: five plugins each bundling audiocrate loaded five
 * worklets onto one context, about 140 kB recompiled on the audio thread
 * apiece, and because the processor name was registered without a guard every
 * copy after the first silently ran the first copy's DSP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioRenderer } from '../../../src/renderers/WebAudioRenderer';
import { registerProcessorOnce } from '../../../src/renderers/worklet/registerOnce';

function fakeContext(addModule: (url: string) => Promise<void>) {
  return { audioWorklet: { addModule: vi.fn(addModule) } } as unknown as AudioContext & {
    audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  };
}

describe('WebAudioRenderer worklet loading', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads the module once for two renderers on one context', async () => {
    const context = fakeContext(async () => {});
    const a = new WebAudioRenderer(context, { workletUrl: 'https://x/crate.js' });
    const b = new WebAudioRenderer(context, { workletUrl: 'https://x/crate.js' });
    await Promise.all([a.ensureWorkletLoaded(), b.ensureWorkletLoaded()]);
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(b.loadedWorkletUrl).toBe('https://x/crate.js');
  });

  it('loads separately on separate contexts', async () => {
    const one = fakeContext(async () => {});
    const two = fakeContext(async () => {});
    await new WebAudioRenderer(one, { workletUrl: 'u' }).ensureWorkletLoaded();
    await new WebAudioRenderer(two, { workletUrl: 'u' }).ensureWorkletLoaded();
    expect(one.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(two.audioWorklet.addModule).toHaveBeenCalledTimes(1);
  });

  it('loads separately under a different processor name', async () => {
    const context = fakeContext(async () => {});
    await new WebAudioRenderer(context, { workletUrl: 'a' }).ensureWorkletLoaded();
    await new WebAudioRenderer(context, { workletUrl: 'b', processorName: 'host-voice' }).ensureWorkletLoaded();
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(2);
  });

  it('says so when a second build would have been ignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = fakeContext(async () => {});
    await new WebAudioRenderer(context, { workletUrl: 'crate.js' }).ensureWorkletLoaded();
    await new WebAudioRenderer(context, { workletUrl: 'host-with-kernels.js' }).ensureWorkletLoaded();
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('host-with-kernels.js'));
  });

  it('forgets a failed load, so the next attempt retries', async () => {
    let fail = true;
    const context = fakeContext(async () => {
      if (fail) throw new Error('offline');
    });
    const renderer = new WebAudioRenderer(context, { workletUrl: 'u' });
    await expect(renderer.ensureWorkletLoaded()).rejects.toThrow(/offline/);
    fail = false;
    await renderer.ensureWorkletLoaded();
    await new WebAudioRenderer(context, { workletUrl: 'u' }).ensureWorkletLoaded();
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(2);
  });
});

describe('registerProcessorOnce', () => {
  const scope = globalThis as unknown as { registerProcessor?: unknown };
  afterEach(() => {
    delete scope.registerProcessor;
    vi.restoreAllMocks();
  });

  it('registers a name once and reports the repeat instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = new Set<string>();
    scope.registerProcessor = vi.fn((name: string) => {
      if (seen.has(name)) throw new DOMException('duplicate', 'NotSupportedError');
      seen.add(name);
    });
    const name = `test-processor-${Math.random()}`;
    const Ctor = class {} as unknown as new () => AudioWorkletProcessor;
    expect(registerProcessorOnce(name, Ctor)).toBe(true);
    expect(registerProcessorOnce(name, Ctor)).toBe(false);
    expect(scope.registerProcessor).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('survives a name registered by something outside the registry', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    scope.registerProcessor = vi.fn(() => {
      throw new DOMException('duplicate', 'NotSupportedError');
    });
    const Ctor = class {} as unknown as new () => AudioWorkletProcessor;
    expect(registerProcessorOnce(`foreign-${Math.random()}`, Ctor)).toBe(false);
  });
});
