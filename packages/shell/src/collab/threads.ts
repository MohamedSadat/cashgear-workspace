// A notification's thread, asked for before (or while) its page is on screen: the page view opens
// its comments there (as a notice's "Open the page history" does, page/PageMenu.ts).
import type { Id } from '@cgw/workspace';

/** Threads asked for before their page was on screen. */
const threadsWanted = new Map<Id, Id>();
export const threadEvents = new EventTarget();

/** Opens a page's comments at a thread: now if the page is on screen, else as soon as it is. */
export function openThread(pageId: Id, threadId: Id) {
  threadsWanted.set(pageId, threadId);
  threadEvents.dispatchEvent(new CustomEvent('thread', { detail: { pageId, threadId } }));
}

/** The thread asked for on a page, once: the page view opens its comments there. */
export function takeThreadRequest(pageId: Id): Id | null {
  const threadId = threadsWanted.get(pageId) ?? null;
  threadsWanted.delete(pageId);
  return threadId;
}
