import type { PageDocument, SaveState } from '@cgw/doc';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { WorkspaceSession } from '../session';

export type PageDocState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PageDocument }
  | { status: 'error'; error: unknown };

const LOADING: PageDocState = { status: 'loading' };

/**
 * Opens a page's document through the session; the session keeps a few open. A state counts only
 * for the page it was loaded for: on the render that switches pages, the last page's document is
 * never handed out under the new page.
 */
export function usePageDoc(session: WorkspaceSession, pageId: string): PageDocState {
  const [loaded, setLoaded] = useState<{ pageId: string; state: PageDocState } | null>(null);
  useEffect(() => {
    let live = true;
    session.openDoc(pageId).then(
      (doc) => live && setLoaded({ pageId, state: { status: 'ready', doc } }),
      (error: unknown) => live && setLoaded({ pageId, state: { status: 'error', error } }),
    );
    return () => {
      live = false;
    };
  }, [session, pageId]);
  return loaded?.pageId === pageId ? loaded.state : LOADING;
}

export function useSaveState(doc: PageDocument | null): SaveState | null {
  return useSyncExternalStore(
    (listener) => (doc ? doc.onSaveState(listener) : () => {}),
    () => doc?.saveState ?? null,
  );
}
