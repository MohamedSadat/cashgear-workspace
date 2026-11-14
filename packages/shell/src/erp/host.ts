// The ERP part of a page's editor host (`EditorHost.erp`): blocks mount `ErpView` over the tab's
// ERP services, told of the app's connection to Workspace's API when it comes.
import type { EditorHost } from '@cgw/editor';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import type { WorkspaceSession } from '../session';
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

/** `EditorHost.erp` for a page; undefined (the block's placeholder) when the build has no ERP. */
export function useErpHost(session: WorkspaceSession): EditorHost['erp'] {
  const { i18n } = useTranslation();
  const services = useErpServices(session);
  return useMemo(
    () =>
      services
        ? { mount: (element, options) => mountErp(element, options, { services, i18n }) }
        : undefined,
    [services, i18n],
  );
}
