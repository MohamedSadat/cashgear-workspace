// What a page's editor is given for workbooks (`EditorHost.workbooks`, contracts section 2): the
// block's frame (mount.tsx), "New workbook" and "Existing workbook" (the frame's dialogs,
// requests.ts). One set of services per session: the picture cache over its store, and the
// connection to the server, which comes after the first page may already be on screen (a block
// drawn before it reads it as it comes).
import type { EditorHost } from '@cgw/editor';
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
import { useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import type { WorkspaceSession } from '../session';
import { mountWorkbook, type WorkbookMountDeps } from './mount';
import { WorkbookPictures } from './pictures';
import { requestNewWorkbook, requestWorkbookPick } from './requests';

/** The connection as a block reads it: the current one, and when it changes. */
export interface CloudSource {
  get(): Cloud | null;
  subscribe(listener: () => void): () => void;
}

class WorkbookServices implements CloudSource {
  private cloud: Cloud | null = null;
  private readonly listeners = new Set<() => void>();
  readonly pictures: WorkbookPictures;

  constructor(session: WorkspaceSession) {
    this.pictures = new WorkbookPictures(session.store);
  }

  get = () => this.cloud;

  set(cloud: Cloud | null) {
    if (cloud === this.cloud) return;
    this.cloud = cloud;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

const services = new WeakMap<WorkspaceSession, WorkbookServices>();

export function workbookServices(session: WorkspaceSession): WorkbookServices {
  let found = services.get(session);
  if (!found) {
    found = new WorkbookServices(session);
    services.set(session, found);
  }
  return found;
}

export function workbooksHost(deps: WorkbookMountDeps): NonNullable<EditorHost['workbooks']> {
  return {
    mount: (element, options) => mountWorkbook(element, options, deps),
    create: requestNewWorkbook,
    pick: requestWorkbookPick,
  };
}

/** The workbooks part of a page's editor host. */
export function useWorkbooksHost(
  session: WorkspaceSession,
  pageId: Id,
): NonNullable<EditorHost['workbooks']> {
  const { i18n } = useTranslation();
  const { platform, theme } = useShell();
  const cloud = useCloud();
  const held = workbookServices(session);
  useEffect(() => held.set(cloud), [held, cloud]);
  return useMemo(
    () =>
      workbooksHost({
        session,
        cloud: held,
        platform,
        theme,
        pictures: held.pictures,
        pageId,
        i18n,
      }),
    [session, held, platform, theme, pageId, i18n],
  );
}
