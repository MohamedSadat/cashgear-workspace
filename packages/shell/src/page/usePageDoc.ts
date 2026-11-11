import type { PageDocument, SaveState } from '@cgw/doc';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { WorkspaceSession } from '../session';

export type PageDocState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PageDocument }
  | { status: 'error'; error: unknown };

/** Opens a page's document through the session; the session keeps a few open. */
export function usePageDoc(session: WorkspaceSession, pageId: string): PageDocState {
  const [state, setState] = useState<PageDocState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    session.openDoc(pageId).then(
      (doc) => live && setState({ status: 'ready', doc }),
      (error: unknown) => live && setState({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [session, pageId]);
  return state;
}

export function useSaveState(doc: PageDocument | null): SaveState | null {
  return useSyncExternalStore(
    (listener) => (doc ? doc.onSaveState(listener) : () => {}),
    () => doc?.saveState ?? null,
  );
}
