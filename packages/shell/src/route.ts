// Routing by page id, in the URL's hash so it works from a static host and from Tauri's own
// protocol alike: #/p/{pageId}, #/p/{pageId}/{blockId}, #/trash, #/settings (after 0.19.0 also
// #/settings/{tab}), from Phase 2
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
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'workbooks' }
  | { kind: 'inbox' }
  | { kind: 'erpLink' }
  | { kind: 'invite'; token: string }
  | { kind: 'shared'; token: string; pageId?: string };

/** Settings' tabs (frame/Settings.tsx): `#/settings/{tab}`, General when none. */
export type SettingsTab =
  'general' | 'account' | 'members' | 'ai' | 'publishing' | 'integrations' | 'data';
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
  if (kind === 'settings') {
    // General is the bare address; Settings shows it too for a tab it does not list.
    return { kind: 'settings', tab: id as SettingsTab | undefined };
  }
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
      return `#/settings${route.tab ? `/${route.tab}` : ''}`;
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

/**
 * Phase 7: something that leaving a page would lose (ERP changes not committed, erp/leave.tsx)
 * asks first. `blocks` says whether a move must be asked about; `ask` resolves true to leave.
 * While it asks, the app goes on showing the route it was on; staying puts the address back.
 */
export interface LeaveGuard {
  blocks(from: Route, to: Route): boolean;
  ask(from: Route, to: Route): Promise<boolean>;
}

let guard: LeaveGuard | null = null;
/** The hash the app shows while a move is asked about; null when none is. */
let held: string | null = null;
/** The hash the app showed last. */
let last: string | null = null;
const listeners = new Set<() => void>();

/** Sets the one guard; returns what removes it. */
export function setLeaveGuard(next: LeaveGuard | null): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

function onHashChange() {
  const next = location.hash;
  const from = last ?? next;
  if (held !== null) return;
  const current = guard;
  if (current && next !== from) {
    const [a, b] = [parseRoute(from), parseRoute(next)];
    if (current.blocks(a, b)) {
      held = from;
      void current.ask(a, b).then(
        (leave) => {
          if (!leave) history.replaceState(null, '', from || '#/');
          held = null;
          last = location.hash;
          emit();
        },
        () => {
          held = null;
          last = location.hash;
          emit();
        },
      );
      return;
    }
  }
  last = next;
  emit();
}

function emit() {
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  if (listeners.size === 0) {
    last = location.hash;
    window.addEventListener('hashchange', onHashChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('hashchange', onHashChange);
  };
};

/** The current hash; parse it with parseRoute (the string keeps effects stable). */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => held ?? location.hash);
}
