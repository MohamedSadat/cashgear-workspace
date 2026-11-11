// Routing by page id, in the URL's hash so it works from a static host and from Tauri's own
// protocol alike: #/p/{pageId}, #/p/{pageId}/{blockId}, #/trash, #/settings.
import { useSyncExternalStore } from 'react';

export type Route =
  | { kind: 'home' }
  | { kind: 'page'; pageId: string; blockId?: string }
  | { kind: 'trash' }
  | { kind: 'settings' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOCK = /^[0-9A-Za-z]{12}$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [kind, id, blockId] = path.split('/');
  if (kind === 'p' && id && UUID.test(id))
    return blockId && BLOCK.test(blockId)
      ? { kind: 'page', pageId: id, blockId }
      : { kind: 'page', pageId: id };
  if (kind === 'trash') return { kind: 'trash' };
  if (kind === 'settings') return { kind: 'settings' };
  return { kind: 'home' };
}

export function routeHash(route: Route): string {
  switch (route.kind) {
    case 'page':
      return `#/p/${route.pageId}${route.blockId ? `/${route.blockId}` : ''}`;
    case 'trash':
      return '#/trash';
    case 'settings':
      return '#/settings';
    default:
      return '#/';
  }
}

export function navigate(route: Route, replace = false) {
  const hash = routeHash(route);
  if (location.hash === hash) return;
  if (!replace) {
    location.hash = hash;
    return;
  }
  history.replaceState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
};

/** The current hash; parse it with parseRoute (the string keeps effects stable). */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}
