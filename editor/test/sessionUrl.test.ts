import { describe, expect, it } from 'vitest';
import { createRoomId, isRoomId, readRoomId, sessionHref, writeRoomId } from '../src/sessionUrl';

describe('session URL', () => {
  it('mints a room id long enough for p2pcf', () => {
    const id = createRoomId(new Uint8Array([1, 2, 3, 4, 5]));
    expect(isRoomId(id)).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(4);
  });

  it('reads a room id from the query string', () => {
    expect(readRoomId('?room=ab12cd34')).toBe('ab12cd34');
    expect(readRoomId('?other=1')).toBeNull();
    expect(readRoomId('?room=no')).toBeNull();
  });

  it('appends the room id to the current page URL', () => {
    expect(sessionHref('ab12cd34', { href: 'http://localhost:5175/' })).toBe(
      'http://localhost:5175/?room=ab12cd34',
    );
    expect(sessionHref('ab12cd34', { href: 'http://localhost:5175/?x=1' })).toBe(
      'http://localhost:5175/?x=1&room=ab12cd34',
    );
  });

  it('writes and clears the room param without adding a history entry', () => {
    const calls: string[] = [];
    const historyApi = { replaceState: (_state: unknown, _title: string, href: string) => calls.push(href) };
    expect(writeRoomId('ab12cd34', historyApi, { href: 'http://localhost:5175/' })).toBe(
      'http://localhost:5175/?room=ab12cd34',
    );
    expect(writeRoomId(null, historyApi, { href: 'http://localhost:5175/?room=ab12cd34' })).toBe(
      'http://localhost:5175/',
    );
    expect(calls).toEqual(['http://localhost:5175/?room=ab12cd34', 'http://localhost:5175/']);
  });
});
