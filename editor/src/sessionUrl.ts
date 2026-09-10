export const ROOM_PARAM = 'room';
export const PEER_STORAGE_KEY = 'crate.patcher.peer';

export function isRoomId(value: string): boolean {
  return /^[a-z0-9]{4,32}$/.test(value);
}

export function createRoomId(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(5))): string {
  const id = [...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 8);
  return id.length >= 4 ? id : `crate${id}`;
}

export function readRoomId(search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(ROOM_PARAM);
  const room = value?.toLowerCase() ?? null;
  return room && isRoomId(room) ? room : null;
}

export function sessionHref(
  roomId: string,
  location: Pick<Location, 'href'> = window.location,
): string {
  const url = new URL(location.href);
  url.searchParams.set(ROOM_PARAM, roomId);
  return url.toString();
}

export function writeRoomId(
  roomId: string | null,
  historyApi: Pick<History, 'replaceState'> = typeof window !== 'undefined' ? window.history : { replaceState() {} },
  location: Pick<Location, 'href'> = typeof window !== 'undefined' ? window.location : { href: 'http://localhost/' },
): string {
  const url = new URL(location.href);
  if (roomId) url.searchParams.set(ROOM_PARAM, roomId);
  else url.searchParams.delete(ROOM_PARAM);
  const href = url.toString();
  const state = typeof window !== 'undefined' && historyApi === window.history ? window.history.state : {};
  historyApi.replaceState(state, '', href);
  return href;
}

export function localPeerId(store: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage): string {
  const existing = store.getItem(PEER_STORAGE_KEY);
  if (existing && existing.length >= 4) return existing;
  const id = createRoomId();
  store.setItem(PEER_STORAGE_KEY, `peer${id}`);
  return `peer${id}`;
}
