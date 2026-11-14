// `#/erp-link/{ticket}` (INTEGRATIONS.md, "Linking a workspace to a company"): Cash Gear ERP opens
// Workspace with a one-time link ticket in the hash. The ticket is read and the address replaced
// at once (`history.replaceState`), before any route is read, so it never stays in the address
// bar, the history or a later route: the route the app shows is `#/erp-link`, and the ticket
// lives in memory here until the link screen sends it, gives it up, or it runs out (120 s).
import { LIMITS } from '@cgw/erp';

/** The route the screen shows, which holds no ticket. */
export const ERP_LINK_HASH = '#/erp-link';
/** 256 random bits in base64url, as the ERP makes them. */
const WITH_TICKET = /^#\/?erp-link\/([A-Za-z0-9_-]{43})\/?$/;

interface Held {
  ticket: string;
  until: number;
}

let held: Held | null = null;
const listeners = new Set<() => void>();
let expiry: ReturnType<typeof setTimeout> | undefined;

interface Place {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}
interface History {
  readonly state: unknown;
  replaceState(state: unknown, unused: string, url: string): void;
}

/**
 * Takes a link ticket out of the address, if it has one: kept in memory, and the address (and
 * its history entry) replaced by `#/erp-link`. True when one was taken.
 */
export function captureErpLinkTicket(
  place: Place = window.location,
  history_: History = window.history,
  now = Date.now(),
): boolean {
  const m = WITH_TICKET.exec(place.hash);
  if (!m) return false;
  history_.replaceState(history_.state, '', `${place.pathname}${place.search}${ERP_LINK_HASH}`);
  hold(m[1]!, now);
  return true;
}

function hold(ticket: string, now: number) {
  held = { ticket, until: now + LIMITS.ticketMs };
  if (expiry !== undefined) clearTimeout(expiry);
  expiry = setTimeout(forgetErpLinkTicket, LIMITS.ticketMs);
  (expiry as { unref?: () => void }).unref?.();
  emit();
}

/** The held ticket, while it can still be used; never in any route or store. Pure. */
export function heldErpLinkTicket(now = Date.now()): string | null {
  return held && now < held.until ? held.ticket : null;
}

export function forgetErpLinkTicket(): void {
  if (expiry !== undefined) clearTimeout(expiry);
  expiry = undefined;
  if (!held) return;
  held = null;
  emit();
}

export function onErpLinkTicket(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit() {
  for (const listener of [...listeners]) listener();
}

let installed = false;

/**
 * Takes a ticket from the address now, and from every later change of the hash before anything
 * else hears it (a capturing listener, added before the router's). Once per page.
 */
export function installErpLinkCapture(target: Window = window): void {
  if (installed) return;
  installed = true;
  captureErpLinkTicket(target.location, target.history);
  target.addEventListener(
    'hashchange',
    () => captureErpLinkTicket(target.location, target.history),
    { capture: true },
  );
}
