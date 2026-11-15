// The tab's AI: one settings store per connection to the API, and what the page, the settings
// and the ERP assist read of it. Nothing here runs a completion; `run.ts` does.
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Cloud } from '../cloud/cloud';
import { useAccount, useCloud } from '../cloud/CloudUi';
import type { WorkspaceSession } from '../session';
import { cloudAiApi } from './api';
import { availability, AiSettingsStore, type AiAvailability, type AiContext } from './store';

const stores = new WeakMap<Cloud, AiSettingsStore>();

/** The settings store of this connection to the API. */
export function aiStoreOf(cloud: Cloud): AiSettingsStore {
  let store = stores.get(cloud);
  if (!store) {
    store = new AiSettingsStore(cloudAiApi(cloud.api));
    stores.set(cloud, store);
  }
  return store;
}

/** What decides whether AI is offered in a workspace, now. */
export function aiContextOf(
  cloud: Cloud | null,
  session: WorkspaceSession,
  workspaceId: Id | null,
): AiContext {
  const workspace = workspaceId ? session.mirror.workspaces.get(workspaceId) : undefined;
  const state = cloud?.status.state;
  return {
    signedIn: !!cloud?.account,
    synced: !!workspace && workspace.localOnly === false,
    role: workspace?.role ?? null,
    online:
      (typeof navigator === 'undefined' || navigator.onLine !== false) &&
      state !== 'offline' &&
      state !== 'signedOut',
  };
}

export interface AiHandle {
  readonly store: AiSettingsStore;
  readonly workspaceId: Id;
  readonly availability: AiAvailability;
  /** Owners and admins may change the settings (the server decides). */
  readonly canManage: boolean;
}

/** AI in a workspace for this tab, or null when there is no connection to the API. */
export function useAi(session: WorkspaceSession, workspaceId: Id | null): AiHandle | null {
  const cloud = useCloud();
  useAccount(cloud);
  const store = cloud ? aiStoreOf(cloud) : null;
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const offs = [
        store?.subscribe(listener),
        cloud?.subscribe(listener),
        session.mirror.subscribe(listener),
      ];
      window.addEventListener('online', listener);
      window.addEventListener('offline', listener);
      return () => {
        for (const off of offs) off?.();
        window.removeEventListener('online', listener);
        window.removeEventListener('offline', listener);
      };
    },
    [store, cloud, session],
  );
  const state = useSyncExternalStore(subscribe, () =>
    store && workspaceId
      ? availability(store.state(workspaceId), aiContextOf(cloud, session, workspaceId))
      : 'signedOut',
  );
  const role = useSyncExternalStore(subscribe, () =>
    workspaceId ? (session.mirror.workspaces.get(workspaceId)?.role ?? null) : null,
  );
  const signedIn = !!cloud?.account;
  // Read once the workspace is on the account and someone is signed in.
  useEffect(() => {
    if (store && workspaceId && signedIn && state !== 'localWorkspace' && state !== 'signedOut')
      store.load(workspaceId);
  }, [store, workspaceId, signedIn, state]);
  return useMemo(
    () =>
      store && workspaceId
        ? {
            store,
            workspaceId,
            availability: state,
            canManage: role === 'owner' || role === 'admin',
          }
        : null,
    [store, workspaceId, state, role],
  );
}
