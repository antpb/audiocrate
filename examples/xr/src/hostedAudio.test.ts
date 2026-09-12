import { describe, expect, it } from 'vitest';
import { attachNodeToHtmlSink, prefersHtmlAudioSink, shouldConnectWebAudioDestination } from './hostedAudio';

describe('prefersHtmlAudioSink', () => {
  it('is true for iPhone Safari', () => {
    expect(
      prefersHtmlAudioSink(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        5,
        'iPhone',
      ),
    ).toBe(true);
  });

  it('is true for iPad pretending to be Mac', () => {
    expect(prefersHtmlAudioSink('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, 'MacIntel')).toBe(true);
  });

  it('is false for a desktop Mac', () => {
    expect(prefersHtmlAudioSink('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, 'MacIntel')).toBe(false);
  });

  it('is false for desktop Chrome', () => {
    expect(
      prefersHtmlAudioSink(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        0,
        'Win32',
      ),
    ).toBe(false);
  });
});

describe('shouldConnectWebAudioDestination', () => {
  it('keeps destination on desktop', () => {
    expect(shouldConnectWebAudioDestination(false, false)).toBe(true);
    expect(shouldConnectWebAudioDestination(false, true)).toBe(true);
  });

  it('drops destination on iOS once the HTML sink is playing', () => {
    expect(shouldConnectWebAudioDestination(true, false)).toBe(true);
    expect(shouldConnectWebAudioDestination(true, true)).toBe(false);
  });
});

describe('attachNodeToHtmlSink', () => {
  it('does not disconnect destination when no html sink exists', () => {
    const disconnect = () => {
      throw new Error('destination must stay connected on desktop');
    };
    const node = { connect: () => {}, disconnect };
    expect(() => attachNodeToHtmlSink(node, {} as AudioNode)).not.toThrow();
  });
});
