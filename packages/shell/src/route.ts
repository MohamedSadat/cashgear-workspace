// Routing by page id, in the URL's hash so it works from a static host and from Tauri's own
// protocol alike: #/p/{pageId}, #/p/{pageId}/{blockId}, #/trash, #/settings, from Phase 2
// #/invite/{token} (a workspace invitation) and #/s/{token} (a page shared by link), and from
// Phase 3 #/recovered (pages made of changes the server would not take), from Phase 5 #/workbooks
// (the workspace's workbooks) and #/erp-link (Cash Gear ERP's link screen; its ticket is taken out
// of the address before any route is read, erp/linkTicket.ts, and is never part of a route), and
// from Phase 6 #/inbox (the person's notifications). Tokens are in the hash, so they never reach a
// server's logs.
import { useSyncExternalStore } from 'react';

export type Route =
  | { kind: 'home' }
  | { kind: 'page'; pageId: string; blockId?: string }
  | { kind: 'trash' }
  | { kind: 'recovered' }
  | { kind: 'settings' }
  | { kind: 'workbooks' }
  | { kind: 'inbox' }
  | { kind: 'erpLink' }
  | { kind: 'invite'; token: string }
  | { kind: 'shared'; token: string; pageId?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOCK = /^[0-9A-Za-z]{12}$/;
/** 32 random bytes, base64url (invites and share links). */
const TOKEN = /^[0-9A-Za-z_-]{43}$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [kind, id, blockId] = path.split('/');
  if (kind === 'p' && id && UUID.test(id))
    return blockId && BLOCK.test(blockId)
      ? { kind: 'page', pageId: id, blockId }
      : { kind: 'page', pageId: id };
  if (kind === 'invite' && id && TOKEN.test(id)) return { kind: 'invite', token: id };
  if (kind === 's' && id && TOKEN.test(id))
    return blockId && UUID.test(blockId)
      ? { kind: 'shared', token: id, pageId: blockId }
      : { kind: 'shared', token: id };
  if (kind === 'trash') return { kind: 'trash' };
  if (kind === 'recovered') return { kind: 'recovered' };
  if (kind === 'settings') return { kind: 'settings' };
  if (kind === 'workbooks') return { kind: 'workbooks' };
  if (kind === 'inbox') return { kind: 'inbox' };
  // Whatever follows (a ticket not yet taken out) is never read into the route.
  if (kind === 'erp-link') return { kind: 'erpLink' };
  return { kind: 'home' };
}

export function routeHash(route: Route): string {
  switch (route.kind) {
    case 'page':
      return `#/p/${route.pageId}${route.blockId ? `/${route.blockId}` : ''}`;
    case 'trash':
      return '#/trash';
    case 'recovered':
      return '#/recovered';
    case 'settings':
      return '#/settings';
    case 'workbooks':
      return '#/workbooks';
    case 'inbox':
      return '#/inbox';
    case 'erpLink':
      return '#/erp-link';
    case 'invite':
      return `#/invite/${route.token}`;
    case 'shared':
      return `#/s/${route.token}${route.pageId ? `/${route.pageId}` : ''}`;
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

/**
 * A page is gone (trashed, deleted): home, if it is still the one showing. The trash is written
 * after the click, so a route the person chose meanwhile (the trash itself, say) stands.
 */
export function leavePage(pageId: string) {
  const route = parseRoute(location.hash);
  if (route.kind === 'page' && route.pageId === pageId) navigate({ kind: 'home' });
}

const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
};

/** The current hash; parse it with parseRoute (the string keeps effects stable). */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}
