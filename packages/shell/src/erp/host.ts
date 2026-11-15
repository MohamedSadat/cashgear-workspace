// The ERP part of a page's editor host (`EditorHost.erp`): blocks mount `ErpView` over the tab's
// ERP services, told of the app's connection to Workspace's API when it comes. Phase 7: each
// block also gets the page it is on (for the ERP's audit), the tab's drafts, Workspace's audit of
// commit attempts and, when AI is on, the AI that prepares changes; and the tab warns before
// leaving changes behind.
import type { EditorHost } from '@cgw/editor';
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useErpAiAssist } from '../ai/erpAssist';
import { useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import type { WorkspaceSession } from '../session';
import { holdErpLeaveGuard } from './leave';
import { mountErp } from './mount';
import { cloudErp, erpServices, type ShellErp } from './services';

/** The tab's ERP services, told of the cloud; null when this build names no ERP. */
export function useErpServices(session: WorkspaceSession): ShellErp | null {
  const { platform } = useShell();
  const cloud = useCloud();
  const services = platform.erp ? erpServices(session, platform) : null;
  useEffect(() => services?.setCloud(cloud ? cloudErp(cloud) : null), [services, cloud]);
  return services;
}

/**
 * `EditorHost.erp` for a page; undefined (the block's placeholder) when the build has no ERP.
 * Without `pageId` (a view that is not a page of the workspace) blocks stay read-only.
 */
export function useErpHost(session: WorkspaceSession, pageId?: Id): EditorHost['erp'] {
  const { i18n } = useTranslation();
  const { platform } = useShell();
  const services = useErpServices(session);
  const ai = useErpAiAssist(session, pageId);
  useEffect(
    () => (services ? holdErpLeaveGuard(services.drafts, i18n, platform) : undefined),
    [services, i18n, platform],
  );
  return useMemo(
    () =>
      services
        ? {
            mount: (element, options) =>
              mountErp(element, options, { services, i18n, pageId: pageId ?? null, ai }),
          }
        : undefined,
    [services, i18n, pageId, ai],
  );
}
