// The collaboration parts as the interface reaches them: the cloud's `Collab`, given by the app
// (null with no cloud), and hooks that render again only when what they show changes.
import type { Id } from '@cgw/workspace';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { WorkspaceSession } from '../session';
import type { Collab } from './collab';
import type { CommentsStore } from './comments';
import type { PeopleDirectory } from './people';
import type { PagePresence } from './presence';

export const CollabContext = createContext<Collab | null>(null);

export function useCollab(): Collab | null {
  return useContext(CollabContext);
}

/**
 * Whether a workspace is shared through the account: comments, presence and people are for its
 * members only, never for a workspace on this device alone.
 */
export const collaborates = (collab: Collab | null, session: WorkspaceSession, workspaceId: Id) =>
  !!collab &&
  !!collab.deps.self() &&
  session.mirror.workspaces.get(workspaceId)?.localOnly === false;

const none = () => () => {};
const zero = () => 0;
const EMPTY: readonly Id[] = Object.freeze([]);
const nothing = () => EMPTY;

/** The workspace's people, or null; renders again when a name changes. */
export function usePeople(collab: Collab | null, workspaceId: Id | null): PeopleDirectory | null {
  const directory = collab && workspaceId ? collab.people(workspaceId) : null;
  useSyncExternalStore(
    directory ? directory.subscribe : none,
    directory ? directory.getRevision : zero,
  );
  return directory;
}

/** The page's presence store while the component is mounted (shared with the page's editor). */
export function usePagePresence(
  collab: Collab | null,
  pageId: Id | null,
  workspaceId: Id | null,
): PagePresence | null {
  const [store, setStore] = useState<PagePresence | null>(null);
  useEffect(() => {
    if (!collab || !pageId || !workspaceId) {
      setStore(null);
      return;
    }
    const held = collab.presence(pageId, workspaceId);
    setStore(held.store);
    return () => {
      setStore(null);
      held.release();
    };
  }, [collab, pageId, workspaceId]);
  return store;
}

/** The open page's comments while the component is mounted (made in an effect: one per mount). */
export function useCommentsStore(
  collab: Collab | null,
  pageId: Id,
  enabled: boolean,
): CommentsStore | null {
  const [store, setStore] = useState<CommentsStore | null>(null);
  useEffect(() => {
    if (!collab || !enabled) {
      setStore(null);
      return;
    }
    const made = collab.commentsFor(pageId);
    setStore(made);
    return () => {
      setStore(null);
      made.dispose();
    };
  }, [collab, pageId, enabled]);
  return store;
}

/** The others on a page (the top bar): renders again only when someone comes or goes. */
export function usePeopleOnPage(store: PagePresence | null): readonly Id[] {
  return useSyncExternalStore(store ? store.subscribePeople : none, store ? store.people : nothing);
}

/** The others who have a page open (the sidebar's rows). */
export function usePageOpenBy(collab: Collab | null, pageId: Id): readonly Id[] {
  const presence = collab?.workspacePresence;
  return useSyncExternalStore(
    presence ? presence.subscribe : none,
    presence ? () => presence.of(pageId) : nothing,
  );
}

/** The inbox's unread count (the sidebar's entry). */
export function useUnread(collab: Collab | null): number {
  const inbox = collab?.inbox;
  return useSyncExternalStore(inbox ? inbox.subscribe : none, inbox ? inbox.unread : zero);
}
